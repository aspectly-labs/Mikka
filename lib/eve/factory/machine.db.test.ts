import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { test } from 'node:test'
import { Pool } from 'pg'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { hostedSnapshot } from '../../cloud-computer/sponsored-task'
import { machineChunkMicroUsd, machineListUsageMicroUsd, machineSkuGeometry, machineSkuListPrice, MACHINE_CHUNK_MS } from '../../cloud-computer/machine-pricing'
import { dbUrl, seedAgent, seedUser, seedWorkspace } from '../../../tests/support/workspace-admin-db'

type MeterSample =
  | { index: number; provisionedMs: number; activeVcpuMs: number; observedAt: number }
  | { notStarted: true }

test('Eve Factory Cloudflare machines use cgroup-measured holds/settlement and preserve legacy fallback', { skip: !dbUrl }, async t => {
  const fixture = new Pool({ connectionString: dbUrl })
  t.after(() => fixture.end())

  const bridgeToken = 'eve-factory-machine-test-token'
  const envPatch: Record<string, string | undefined> = {
    MIKKA_EDITION: 'cloud',
    MIKKA_TASK_MACHINE_BRIDGE_TOKEN: bridgeToken,
    MIKKA_CLOUDFLARE_TASKS_DISABLED: undefined,
  }
  const savedEnv = Object.fromEntries(Object.keys(envPatch).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(envPatch)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  // Local HTTP mock for the internal Cloudflare task-machine bridge.
  let failOpen = false
  let nextMeterSample: Omit<Extract<MeterSample, { provisionedMs: number }>, 'index' | 'observedAt'> = {
    provisionedMs: 120_000,
    activeVcpuMs: 30_000,
  }
  const openedGrants: Array<{ operationId: string; metered?: boolean; size?: string }> = []
  const meterRequests: Array<{ operationId: string; index: number; rollover: boolean }> = []
  const parkedOperations: string[] = []
  const startedOps = new Map<string, { instanceId: string; stopped: boolean }>()

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      grant: { operationId: string; metered?: boolean; size?: string }
      index?: number
      rollover?: boolean
    }
    assert.equal(req.headers.authorization, `Bearer ${bridgeToken}`)
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const reply = (payload: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
    }

    if (path === '/v1/open') {
      openedGrants.push({
        operationId: body.grant.operationId,
        metered: body.grant.metered,
        size: body.grant.size,
      })
      if (failOpen) return reply({ error: 'capacity_unavailable' }, 503)
      const instanceId = createHash('sha256').update(body.grant.operationId).digest('hex')
      startedOps.set(body.grant.operationId, { instanceId, stopped: false })
      return reply({ state: 'running', instanceId })
    }
    if (path === '/v1/status') {
      const state = startedOps.get(body.grant.operationId)
      if (!state) return reply({ state: 'absent' })
      return reply(state.stopped
        ? { state: 'stopped', instanceId: state.instanceId, stoppedAt: new Date().toISOString(), outcome: 'settled' }
        : { state: 'running', instanceId: state.instanceId })
    }
    if (path === '/v1/park') {
      parkedOperations.push(body.grant.operationId)
      const state = startedOps.get(body.grant.operationId)
      if (!state) return reply({ state: 'absent' })
      state.stopped = true
      return reply({ state: 'stopped', instanceId: state.instanceId, stoppedAt: new Date().toISOString(), outcome: 'settled' })
    }
    if (path === '/v1/compute-meter') {
      const idx = body.index ?? 0
      meterRequests.push({ operationId: body.grant.operationId, index: idx, rollover: Boolean(body.rollover) })
      const state = startedOps.get(body.grant.operationId)
      if (!state) return reply({ notStarted: true })
      return reply({
        index: idx,
        provisionedMs: nextMeterSample.provisionedMs,
        activeVcpuMs: nextMeterSample.activeVcpuMs,
        observedAt: Date.now(),
      })
    }
    return reply({ error: 'unexpected_path' }, 404)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port

  const previousDispatcher = getGlobalDispatcher()
  const dispatcher = new Agent({
    connect(options, complete) {
      if (options.hostname !== 'task-machine.internal' && options.hostname !== '127.0.0.1') {
        complete(new Error(`Unexpected external HTTP host: ${options.hostname}`), null)
        return
      }
      const targetPort = options.hostname === 'task-machine.internal' ? port : Number(options.port)
      const socket = createConnection({ host: '127.0.0.1', port: targetPort })
      const onError = (err: Error) => complete(err, null)
      socket.once('error', onError).once('connect', () => {
        socket.off('error', onError)
        complete(null, socket)
      })
    },
  })
  setGlobalDispatcher(dispatcher)
  t.after(async () => {
    setGlobalDispatcher(previousDispatcher)
    await dispatcher.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  const { pool } = await import('@/lib/db')
  const { workspacePool } = await import('@/lib/workspace-db')
  t.after(() => Promise.allSettled([pool.end(), workspacePool.end()]))

  const ownerId = await seedUser(fixture, 'eve-factory-cf')
  const { id: workspaceId } = await seedWorkspace(fixture, ownerId, [{ userId: ownerId, role: 'admin' }])
  await fixture.query(
    `INSERT INTO workspace_credit_grants (id,"workspaceId",points,bucket,reason,"externalId")
     VALUES ($1,$2,500,'purchased','test',$3)`,
    [randomUUID(), workspaceId, randomUUID()],
  )

  const deviceId = randomUUID()
  const repoId = randomUUID()
  const repoKey = 'v2/github.com/example/eve-factory-billing'
  const remoteUrl = 'https://github.com/example/eve-factory-billing.git'
  const botId = randomUUID()
  const agentId = await seedAgent(fixture, ownerId)
  await fixture.query(
    `INSERT INTO devices (id,"ownerId",name,kind,enabled,harnesses)
     VALUES ($1,$2,'Eve Factory Cloud','cloud',true,$3)`,
    [deviceId, ownerId, JSON.stringify([{ harness: 'codex', installed: true, models: ['gpt-5'] }])],
  )
  await fixture.query(
    `INSERT INTO device_repos (id,"userId","deviceId","repoPath","remoteUrl","baseBranch")
     VALUES ($1,$2,$3,$4,$5,'main')`,
    [repoId, ownerId, deviceId, repoKey, remoteUrl],
  )
  await fixture.query(
    `INSERT INTO bots (id,"ownerId","workspaceId",name)
     VALUES ($1,$2,$3,'Factory Bot')`,
    [botId, ownerId, workspaceId],
  )

  const seedFactoryRun = async (options: { metered: boolean }) => {
    const issueId = randomUUID()
    const runId = randomUUID()
    const eventId = randomUUID()
    const initialOpId = randomUUID()
    await fixture.query(
      `INSERT INTO issues (id,"userId","workspaceId",title,content,status,priority,"ownershipState")
       VALUES ($1,$2,$3,'Factory billing task','{"type":"doc","content":[]}','doing','normal','bound')`,
      [issueId, ownerId, workspaceId],
    )
    await fixture.query(
      `INSERT INTO coordinator_events (id,"userId","botId","issueId",kind,"dedupeKey",payload,"deliveredAt")
       VALUES ($1,$2,$3,$4,'user_message',$5,'{"taskDestination":{"kind":"cloud","provider":"cloudflare"}}',now())`,
      [eventId, ownerId, botId, issueId, `eve-factory-test:${eventId}`],
    )
    const taskMachine = {
      provider: 'cloudflare' as const,
      payer: 'mikka' as const,
      ownerId,
      workspaceId,
      taskId: issueId,
      botId,
      repositoryKey: repoKey,
      requestEventId: eventId,
      size: 'standard-3' as const,
    }
    const definition: Record<string, unknown> = {
      harness: 'codex',
      credits: true,
      taskMachine,
      ...(options.metered ? { taskCompute: { provider: 'cloudflare', size: 'standard-3' } } : {}),
      projectExecution: {
        workspaceId,
        projectId: null,
        repositoryKey: repoKey,
        baseBranch: 'main',
        environment: null,
      },
    }
    const { freezeExecutionIdentity } = await import('../../execution-identity')
    definition.executionIdentity = await freezeExecutionIdentity(
      fixture,
      { userId: ownerId, botId, deviceId, agentDefinition: definition as never },
      undefined,
      workspaceId,
    )
    await fixture.query(
      `INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,kind,"baseBranch",prompt,"botId","agentDefinition","workspaceId")
       VALUES ($1,$2,$3,$4,$5,$6,'queued','execute','main','Fix issue',$7,$8,$9)`,
      [runId, ownerId, issueId, agentId, deviceId, repoId, botId, JSON.stringify(definition), workspaceId],
    )
    await fixture.query(
      `INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)`,
      [runId, botId, workspaceId, ownerId],
    )
    await fixture.query(
      `INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","snapshotId","operationId",state,"issueId","deviceId","repoId")
       VALUES ($1,$2,$3,$4,$5,$6,'starting',$7,$8,$9)`,
      [runId, workspaceId, ownerId, botId, hostedSnapshot, initialOpId, issueId, deviceId, repoId],
    )
    return { runId, issueId }
  }

  const { openEveFactoryMachine, releaseEveFactoryMachine } = await import('./machine')
  const actor = { userId: ownerId, workspaceId }
  const price = machineSkuListPrice({ provider: 'cloudflare', size: 'standard-3' })
  assert.ok(price && price.basis === 'active_cpu')
  const expectedHold = machineListUsageMicroUsd(
    price,
    MACHINE_CHUNK_MS,
    machineSkuGeometry({ provider: 'cloudflare', size: 'standard-3' }).vcpu * MACHINE_CHUNK_MS,
  )
  assert.ok(expectedHold && expectedHold > 0)

  // 1) Metered Cloudflare run: open holds cgroup list max, release settles exact measured usage.
  const meteredRun = await seedFactoryRun({ metered: true })
  const turn1 = await openEveFactoryMachine(pool, actor, meteredRun.runId)
  assert.equal(openedGrants.at(-1)?.operationId, turn1.operationId)
  assert.equal(openedGrants.at(-1)?.metered, true)
  assert.equal(openedGrants.at(-1)?.size, 'standard-3')

  const turn1UsageId = `machine:${meteredRun.runId}:${turn1.operationId}:0`
  const { rows: [heldRow] } = await fixture.query<{
    state: string; model: string; hold: number; cost: number | null; source: string | null
  }>(
    `SELECT state,model,"holdMicroUsd"::int AS hold,"costMicroUsd"::int AS cost,"machineCompute"->>'source' AS source
     FROM hosted_usage WHERE id=$1`,
    [turn1UsageId],
  )
  assert.deepEqual(heldRow, {
    state: 'unknown',
    model: 'machine/cloudflare-standard-3',
    hold: expectedHold,
    cost: null,
    source: 'cloudflare_cgroup_list',
  })

  const { rows: [machineAfterOpen] } = await fixture.query<{
    state: string; portableCompute: boolean; sponsoredChunks: number; sponsoredRepositoryKey: string | null
  }>(
    `SELECT state,(lifecycle->>'portableCompute')::boolean AS "portableCompute",
       (lifecycle->>'sponsoredChunks')::int AS "sponsoredChunks",
       lifecycle->>'sponsoredRepositoryKey' AS "sponsoredRepositoryKey"
     FROM thread_machines WHERE "runId"=$1`,
    [meteredRun.runId],
  )
  assert.deepEqual(machineAfterOpen, {
    state: 'running',
    portableCompute: true,
    sponsoredChunks: 1,
    sponsoredRepositoryKey: repoKey,
  })

  await releaseEveFactoryMachine(pool, actor, meteredRun.runId, turn1.operationId)
  const expectedTurn1Cost = machineListUsageMicroUsd(price, 120_000, 30_000)
  const { rows: [settledTurn1] } = await fixture.query<{ state: string; cost: number; measured: number }>(
    `SELECT state,"costMicroUsd"::int AS cost,("machineCompute"->>'measuredCost')::int AS measured
     FROM hosted_usage WHERE id=$1`,
    [turn1UsageId],
  )
  assert.deepEqual(settledTurn1, { state: 'settled', cost: expectedTurn1Cost, measured: expectedTurn1Cost })
  assert.deepEqual(meterRequests.at(-1), { operationId: turn1.operationId, index: 0, rollover: false })

  // 2) Second role turn on the same run allocates a new operationId starting at meter index 0.
  nextMeterSample = { provisionedMs: 60_000, activeVcpuMs: 10_000 }
  const turn2 = await openEveFactoryMachine(pool, actor, meteredRun.runId)
  assert.notEqual(turn2.operationId, turn1.operationId)
  await releaseEveFactoryMachine(pool, actor, meteredRun.runId, turn2.operationId)
  assert.deepEqual(meterRequests.at(-1), { operationId: turn2.operationId, index: 0, rollover: false })
  const turn2UsageId = `machine:${meteredRun.runId}:${turn2.operationId}:0`
  const expectedTurn2Cost = machineListUsageMicroUsd(price, 60_000, 10_000)
  const { rows: [settledTurn2] } = await fixture.query<{ state: string; cost: number }>(
    `SELECT state,"costMicroUsd"::int AS cost FROM hosted_usage WHERE id=$1`,
    [turn2UsageId],
  )
  assert.deepEqual(settledTurn2, { state: 'settled', cost: expectedTurn2Cost })

  // 3) Metered open failure fences DO via /v1/park and settles hold immediately to $0 (not_started).
  failOpen = true
  const failedRun = await seedFactoryRun({ metered: true })
  await assert.rejects(() => openEveFactoryMachine(pool, actor, failedRun.runId))
  failOpen = false
  const failedOpId = openedGrants.at(-1)!.operationId
  assert.ok(parkedOperations.includes(failedOpId), 'open failure must park/fence abandoned DO operation')
  const { rows: [failedRow] } = await fixture.query<{ state: string; cost: number; outcome: string | null }>(
    `SELECT state,"costMicroUsd"::int AS cost,"machineCompute"->>'outcome' AS outcome
     FROM hosted_usage WHERE id=$1`,
    [`machine:${failedRun.runId}:${failedOpId}:0`],
  )
  assert.deepEqual(failedRow, { state: 'settled', cost: 0, outcome: 'not_started' })

  // 4) Legacy run without taskCompute still falls back to legacy prepaid chunk billing.
  const legacyRun = await seedFactoryRun({ metered: false })
  const legacyOpen = await openEveFactoryMachine(pool, actor, legacyRun.runId)
  assert.equal(openedGrants.at(-1)?.metered, undefined)
  const { rows: [legacyUsage] } = await fixture.query<{
    state: string; cost: number; source: string | null
  }>(
    `SELECT state,"costMicroUsd"::int AS cost,"machineCompute"->>'source' AS source
     FROM hosted_usage WHERE id=$1`,
    [`machine:${legacyRun.runId}:${legacyOpen.operationId}:0`],
  )
  assert.deepEqual(legacyUsage, {
    state: 'settled',
    cost: machineChunkMicroUsd('standard-3'),
    source: null,
  })
})
