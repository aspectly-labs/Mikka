import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { Sandbox } from 'e2b'
import { Pool } from 'pg'
import { dbUrl, seedAgent, seedRun, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'

test('hosted E2B prepays each verified five-minute interval once', { skip: !dbUrl }, async t => {
  const fixture = new Pool({ connectionString: dbUrl })
  t.after(() => fixture.end())
  const ownerId = await seedUser(fixture, 'e2b-billing')
  const { id: workspaceId } = await seedWorkspace(fixture, ownerId, [{ userId: ownerId, role: 'admin' }])
  const agentId = await seedAgent(fixture, ownerId)
  const runId = await seedRun(fixture, { userId: ownerId, agentId, workspaceId, status: 'queued' })

  const workerSha = 'a'.repeat(40)
  const templates = {
    desktop: { templateId: 'verified-desktop', models: [], baseTemplate: 'desktop', preinstalled: true },
    claude: { templateId: 'verified-claude', models: [], baseTemplate: 'claude', preinstalled: true },
    codex: { templateId: 'verified-codex', models: [], baseTemplate: 'codex', preinstalled: true },
  }
  const env = { MIKKA_EDITION: 'cloud', E2B_API_KEY: 'synthetic-fixture-key', E2B_TEAM_ID: 'fixture', MIKKA_CLOUD_WORKER_SHA: workerSha,
    E2B_BYO_COMPUTER_TEMPLATE: templates.desktop.templateId, E2B_CLAUDE_TEMPLATE: templates.claude.templateId,
    E2B_CODEX_TEMPLATE: templates.codex.templateId, MIKKA_CLOUD_TEMPLATE_MODELS: JSON.stringify({
      version: 1, workerSha, templates, machineVariants: Object.entries(templates).map(([kind, template]) => ({
        kind, size: 'medium', templateId: template.templateId, cpuCount: 2, memoryMB: 8192,
      })),
    }) }
  const savedEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const { pool } = await import('@/lib/db')
  pool.options.max = 1
  pool.options.connectionTimeoutMillis = 5_000
  const { workspaceDb, workspacePool } = await import('@/lib/workspace-db')
  workspacePool.options.max = 1
  workspacePool.options.connectionTimeoutMillis = 5_000
  t.after(() => Promise.allSettled([pool.end(), workspacePool.end()]))
  const { createPrepaidE2B, e2bCanReplaceOperation, e2bCreationTimeout, e2bInitialAllocationNeedsRecovery, e2bSandboxTimeout, verifyE2BAllocation } = await import('./e2b-compute-billing')
  const operationId = randomUUID()
  const sandboxId = `sandbox-${operationId}`
  const create = () => e2bCreationTimeout(ownerId, 'team:fixture', operationId, templates.codex.templateId,
    { workspaceId, runId }, 900_000)
  const receipts = async () => (await fixture.query(`SELECT id,model,state,"costMicroUsd"::int AS cost,"usageRunId" AS "runId",
    "unpaidMicroUsd"::int AS unpaid FROM hosted_usage WHERE "usageWorkspaceId"=$1 ORDER BY id`, [workspaceId])).rows

  await assert.rejects(create(), { code: 'e2b_limit_reached' })
  assert.deepEqual(await receipts(), [])
  await fixture.query("INSERT INTO workspace_credit_grants (id,\"workspaceId\",points,bucket,reason,\"externalId\") VALUES ($1,$2,4,'purchased','test',$3)", [randomUUID(), workspaceId, randomUUID()])
  const firstStopId = randomUUID()
  await fixture.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [runId])
  await assert.rejects(e2bCreationTimeout(ownerId, 'team:fixture', firstStopId, templates.codex.templateId,
    { workspaceId, runId }, 900_000), { code: 'e2b_limit_reached' })
  assert.deepEqual(await receipts(), [])
  await fixture.query('UPDATE agent_runs SET "stopRequestedAt"=NULL WHERE id=$1', [runId])

  const first = await workspaceDb.transaction(() => create())
  const initial = [first, ...await Promise.all(Array.from({ length: 4 }, create))]
  assert.ok(initial.every(ms => ms > 270_000 && ms <= 300_000 && ms % 1_000 === 0))
  await verifyE2BAllocation(ownerId, operationId, sandboxId, {}, { cpuCount: 2, memoryMB: 8192 })
  await fixture.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","sandboxId","snapshotId","operationId",state)
    VALUES ($1,$2,$3,$4,$5,$6,'running')`, [runId, workspaceId, ownerId, sandboxId, templates.codex.templateId, operationId])
  const { readThreadMachinePlacement } = await import('../thread-machine-view')
  const machine = await readThreadMachinePlacement(fixture, ownerId, [runId])
  assert.deepEqual(machine?.machine.cloud?.compute, { size: 'medium', cpuCount: 2, memoryMB: 8192, hourlyMicroUsd: 240000 })
  assert.equal(await readThreadMachinePlacement(fixture, 'another-owner', [runId]), null)
  const expected = (index: number, chargedRunId: string | null) => (
    { id: `machine:e2b:${operationId}:${index}`, model: 'machine/e2b-medium', state: 'settled', cost: 20_000, runId: chargedRunId, unpaid: 0 })
  assert.deepEqual(await receipts(), [expected(0, runId)])

  await fixture.query(`UPDATE e2b_compute_leases SET "paidUntil"=now()+interval '30 seconds' WHERE "operationId"=$1`, [operationId])
  assert.ok(await e2bSandboxTimeout(ownerId, sandboxId, 900_000, false) < 30_000)
  assert.deepEqual(await receipts(), [expected(0, runId)])
  await fixture.query(`INSERT INTO e2b_resource_accounts (kind,id,"ownerId",scope) VALUES ('sandbox',$1,$2,'team:fixture')`, [sandboxId, ownerId])
  await fixture.query(`UPDATE agent_runs SET status='running',"leaseExpiresAt"=now()+interval '10 minutes' WHERE id=$1`, [runId])
  const lifecycleInfo = t.mock.method(Sandbox, 'getInfo', async () => ({
    sandboxId, state: 'running', endAt: new Date(Date.now()+30_000), cpuCount: 2, memoryMB: 8192,
  }) as Awaited<ReturnType<typeof Sandbox.getInfo>>)
  const lifecycleTimeout = t.mock.method(Sandbox, 'setTimeout', async (_id: string, timeoutMs: number) => {
    assert.ok(timeoutMs > 300_000 && timeoutMs <= 330_000)
  })
  try {
    const { reconcileThreadMachine } = await import('./thread-lifecycle')
    assert.ok(await reconcileThreadMachine(pool, { userId: ownerId, workspaceId }, runId))
    assert.equal(lifecycleTimeout.mock.callCount(), 1, 'real lifecycle reuses no second APP checkout')
  } finally {
    lifecycleInfo.mock.restore()
    lifecycleTimeout.mock.restore()
  }
  const renewed = await Promise.all(Array.from({ length: 4 }, () => e2bSandboxTimeout(ownerId, sandboxId, 900_000)))
  assert.ok(renewed.every(ms => ms > 300_000 && ms <= 330_000))
  assert.deepEqual(await receipts(), [expected(0, runId), expected(1, runId)])

  await fixture.query(`UPDATE e2b_compute_leases SET "paidUntil"=now()-interval '1 second' WHERE "operationId"=$1`, [operationId])
  await assert.rejects(e2bSandboxTimeout(ownerId, sandboxId, 900_000), { code: 'e2b_limit_reached' })
  assert.deepEqual(await receipts(), [expected(0, runId), expected(1, runId)])

  const successorId = await seedRun(fixture, { userId: ownerId, agentId, workspaceId, status: 'queued' })
  await fixture.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [runId])
  await fixture.query('UPDATE thread_machines SET "runId"=$2 WHERE "runId"=$1', [runId, successorId])
  await fixture.query(`UPDATE e2b_compute_leases SET "paidUntil"=now()+interval '30 seconds',
    "pendingAt"=now(),"pendingRunId"=$2 WHERE "operationId"=$1`, [operationId, runId])
  await fixture.query(`INSERT INTO workspace_credit_grants (id,"workspaceId",points,bucket,reason,"externalId") VALUES ($1,$2,2,'purchased','test',$3)`,
    [randomUUID(), workspaceId, randomUUID()])
  assert.ok(await e2bSandboxTimeout(ownerId, sandboxId, 900_000) < 30_000)
  assert.deepEqual(await receipts(), [expected(0, runId), expected(1, runId)])
  assert.ok(await e2bSandboxTimeout(ownerId, sandboxId, 900_000) > 300_000)
  assert.deepEqual(await receipts(), [expected(0, runId), expected(1, runId), expected(2, successorId)])
  await fixture.query('UPDATE agent_runs SET "stopRequestedAt"=NULL WHERE id=$1', [runId])

  // Let PostgreSQL settle the receipt, then hold the actual lifecycle
  // callback before it can acquire the run lock and send the provider timeout.
  const { threadLifecycleProvider } = await import('./thread-lifecycle-provider')
  const { reconcileThreadMachine } = await import('./thread-lifecycle')
  const raceInfo = t.mock.method(Sandbox, 'getInfo', async () => ({
    sandboxId, state: 'running', endAt: new Date(Date.now()+30_000), cpuCount: 2, memoryMB: 8192,
  }) as Awaited<ReturnType<typeof Sandbox.getInfo>>)
  const raceTimeout = t.mock.method(Sandbox, 'setTimeout', async () => assert.fail('Stop won before provider renewal'))
  const actualPrepare = threadLifecycleProvider.prepareKeepAlive
  try {
    for (const [index, useConcurrently] of [[3,false],[4,true]] as const) {
      await fixture.query(`UPDATE agent_runs SET "stopRequestedAt"=NULL,status='running',"leaseExpiresAt"=now()+interval '10 minutes' WHERE id=$1`, [successorId])
      await fixture.query(`UPDATE thread_machines SET lifecycle='{}',"lifecycleAt"=NULL WHERE "runId"=$1`, [successorId])
      await fixture.query(`UPDATE e2b_compute_leases SET "paidUntil"=now()+interval '30 seconds' WHERE "operationId"=$1`, [operationId])
      await fixture.query(`INSERT INTO workspace_credit_grants (id,"workspaceId",points,bucket,reason,"externalId") VALUES ($1,$2,2,'purchased','test',$3)`,
        [randomUUID(), workspaceId, randomUUID()])
      const settled = Promise.withResolvers<void>()
      const proceed = Promise.withResolvers<void>()
      const barrier = t.mock.method(threadLifecycleProvider, 'prepareKeepAlive', async (...args: Parameters<typeof actualPrepare>) => {
        const prepared = await actualPrepare(...args)
        settled.resolve()
        await proceed.promise
        return prepared
      })
      const maintenance = reconcileThreadMachine(pool, { userId: ownerId, workspaceId }, successorId)
      try {
        await Promise.race([settled.promise, maintenance.then(() => assert.fail('Renewal did not reach its fence'))])
        assert.equal((await receipts()).find(row => row.id === expected(index, successorId).id)?.state, 'settled')
        if (useConcurrently) assert.ok(await e2bSandboxTimeout(ownerId, sandboxId, 900_000) > 300_000)
        await fixture.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [successorId])
      } finally {
        proceed.resolve()
        await maintenance
        barrier.mock.restore()
      }
      assert.equal(raceTimeout.mock.callCount(), 0)
      assert.deepEqual((await receipts()).find(row => row.id === expected(index, successorId).id),
        useConcurrently ? expected(index, successorId) : { ...expected(index, successorId), state: 'failed', cost: 0 })
    }
  } finally {
    raceTimeout.mock.restore()
    raceInfo.mock.restore()
  }

  // A provider hardware mismatch is killed before exposing the instance and
  // releases the prepaid receipt. There is no up/down-tier price adjustment.
  await fixture.query("INSERT INTO workspace_credit_grants (id,\"workspaceId\",points,bucket,reason,\"externalId\") VALUES ($1,$2,2,'purchased','test',$3)",
    [randomUUID(), workspaceId, randomUUID()])
  const mismatchOperation = randomUUID()
  const wrongHardware = t.mock.method(Sandbox, 'getInfo', async () => ({ cpuCount: 4, memoryMB: 16384 }) as Awaited<ReturnType<typeof Sandbox.getInfo>>)
  const kill = t.mock.method(Sandbox, 'kill', async () => true)
  await e2bCreationTimeout(ownerId, 'team:fixture', mismatchOperation, templates.codex.templateId, { workspaceId, runId }, 900_000)
  await assert.rejects(verifyE2BAllocation(ownerId, mismatchOperation, 'wrong-hardware', {}), { code: 'e2b_template_unavailable' })
  assert.equal(wrongHardware.mock.callCount(), 1)
  assert.equal(kill.mock.callCount(), 1)
  assert.equal(kill.mock.calls[0].arguments[0], 'wrong-hardware')
  assert.ok((await receipts()).some(row => row.id === `machine:e2b:${mismatchOperation}:0` && row.state === 'failed' && row.cost === 0))
  assert.equal((await fixture.query('SELECT "sandboxId" FROM e2b_compute_leases WHERE "operationId"=$1', [mismatchOperation])).rows[0].sandboxId, null)

  const refusedOperation = randomUUID()
  await e2bCreationTimeout(ownerId, 'team:fixture', refusedOperation, templates.codex.templateId, { workspaceId, runId }, 900_000)
  const uncertain = Object.assign(new Error('response lost'), { status: 503 })
  await assert.rejects(createPrepaidE2B(ownerId, refusedOperation, async () => { throw uncertain }), error => error === uncertain)
  assert.equal(await e2bCanReplaceOperation(fixture, ownerId, refusedOperation), false)
  const refused = Object.assign(new Error('template gone'), { status: 404 })
  await assert.rejects(createPrepaidE2B(ownerId, refusedOperation, async () => { throw refused }), error => error === refused)
  assert.equal(await e2bCanReplaceOperation(fixture, ownerId, refusedOperation), false)

  const requests: { key: string | undefined; body: string }[] = []
  const discovered: URL[] = []
  const originalApiUrl = process.env.E2B_API_URL
  t.after(() => {
    if (originalApiUrl === undefined) delete process.env.E2B_API_URL
    else process.env.E2B_API_URL = originalApiUrl
  })
  let responseStatus = 422
  const provider = createServer(async (req, res) => {
    if (req.method === 'GET') {
      discovered.push(new URL(req.url ?? '/', 'http://127.0.0.1'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('[]')
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ key: req.headers['idempotency-key'] as string | undefined, body })
    res.writeHead(responseStatus, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: responseStatus,
      error_code: responseStatus === 422 ? 'idempotency_outcome_unknown' : 'denied',
      message: responseStatus === 422 ? 'idempotency_outcome_unknown' : 'origin denied' }))
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  t.after(() => { provider.closeAllConnections(); provider.close() })
  const address = provider.address()
  assert.ok(address && typeof address === 'object')
  const createOnWire = async (operationId: string) => {
    const timeoutMs = await e2bCreationTimeout(ownerId, 'team:fixture', operationId, templates.desktop.templateId, { workspaceId, runId: null }, 900_000)
    return createPrepaidE2B(ownerId, operationId, () => Sandbox.create(templates.desktop.templateId, {
      apiUrl: `http://127.0.0.1:${address.port}`, apiKey: 'synthetic-fixture-key', idempotencyKey: operationId, timeoutMs,
      lifecycle: { onTimeout: 'pause', autoResume: false }, retries: 0,
    }))
  }
  for (const status of [401, 403]) {
    responseStatus = status
    const denied = randomUUID()
    await assert.rejects(createOnWire(denied))
    assert.equal(await e2bCanReplaceOperation(fixture, ownerId, denied), true)
  }
  const missingOperation = randomUUID()
  responseStatus = 422
  await assert.rejects(createOnWire(missingOperation))
  await assert.rejects(createOnWire(missingOperation))
  assert.deepEqual(requests.slice(-2).map(request => request.key), [missingOperation, missingOperation])
  assert.equal(requests.at(-1)?.body, requests.at(-2)?.body)
  assert.equal(JSON.parse(requests.at(-1)!.body).timeout, 300)
  responseStatus = 403
  await assert.rejects(createOnWire(missingOperation))
  assert.equal(await e2bCanReplaceOperation(fixture, ownerId, missingOperation), false)
  await fixture.query(`UPDATE e2b_compute_leases SET "paidUntil"=now()-interval '1 second' WHERE "operationId"=$1`, [missingOperation])
  await fixture.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId",state,"lastActiveAt")
    VALUES ($1,$2,$3,'error',now()-interval '31 seconds')`, [workspaceId, ownerId, missingOperation])
  await fixture.query(`INSERT INTO e2b_resource_accounts (kind,id,"ownerId",scope) VALUES ('operation',$1,$2,'team:fixture')`, [missingOperation, ownerId])
  process.env.E2B_API_URL = `http://127.0.0.1:${address.port}`
  const { reconcileCloudMachines } = await import('../computer/reconcile')
  const { runRecoveryDueSweeps } = await import('../run-recovery-due')
  assert.equal(await e2bInitialAllocationNeedsRecovery(ownerId, missingOperation), true)
  assert.ok((await runRecoveryDueSweeps(pool, { factoryLifecycle: false })).due.has('machines'))
  assert.equal(await reconcileCloudMachines(pool), 0)
  assert.equal(await e2bCanReplaceOperation(fixture, ownerId, missingOperation), false)
  await fixture.query(`UPDATE e2b_compute_leases SET "creationMissingAt"=now()-interval '31 seconds' WHERE "operationId"=$1`, [missingOperation])
  await fixture.query(`UPDATE cloud_machines SET "lastActiveAt"=now()-interval '31 seconds' WHERE "operationId"=$1`, [missingOperation])
  assert.equal(await reconcileCloudMachines(pool), 0)
  assert.equal(await e2bCanReplaceOperation(fixture, ownerId, missingOperation), true)
  assert.equal(discovered.length, 2)
  assert.ok(discovered.every(url => url.pathname === '/v2/sandboxes'
    && url.searchParams.get('metadata')?.includes(`operationId=${missingOperation}`)))

  // Failpoint: the independent HostedUsage transaction committed, but the
  // worker exited before installing the paid interval on the operation.
  const interrupted = randomUUID()
  await e2bCreationTimeout(ownerId, 'team:fixture', interrupted, templates.desktop.templateId, { workspaceId, runId: null }, 900_000)
  await fixture.query(`UPDATE e2b_compute_leases SET "paidUntil"=NULL,"chunkIndex"=-1,"activeChunkIndex"=-1,
    "pendingAt"=now()-interval '6 minutes' WHERE "operationId"=$1`, [interrupted])
  await fixture.query(`UPDATE cloud_machines SET "operationId"=$1,"lastActiveAt"=now()-interval '31 seconds'
    WHERE "workspaceId"=$2 AND "ownerId"=$3`, [interrupted, workspaceId, ownerId])
  assert.ok((await runRecoveryDueSweeps(pool, { factoryLifecycle: false })).due.has('machines'))
  assert.equal(await reconcileCloudMachines(pool), 0)
  assert.equal(await e2bCanReplaceOperation(fixture, ownerId, interrupted), true)
  assert.equal(discovered.length, 2)
  assert.ok((await receipts()).some(row => row.id === `machine:e2b:${interrupted}:0` && row.state === 'failed' && row.cost === 0))

  const existingSandboxId = `existing-${randomUUID()}`
  await fixture.query(`UPDATE cloud_machines SET "sandboxId"=$3,"operationId"=$4,state='running' WHERE "workspaceId"=$1 AND "ownerId"=$2`,
    [workspaceId, ownerId, existingSandboxId, randomUUID()])
  await fixture.query(`INSERT INTO e2b_resource_accounts (kind,id,"ownerId",scope) VALUES ('sandbox',$1,$2,'team:fixture')`, [existingSandboxId, ownerId])
  const existing = await e2bSandboxTimeout(ownerId, existingSandboxId, 900_000, true, {
    providerScope: 'team:fixture',
    inspect: async () => ({ sandboxId: existingSandboxId, templateId: 'retired-desktop', cpuCount: 2, memoryMB: 8192 }) as Awaited<ReturnType<typeof Sandbox.getInfo>>,
  })
  assert.ok(existing > 270_000 && existing <= 300_000)

  const afterMismatch = await receipts()
  process.env.MIKKA_EDITION = 'community'
  assert.equal(await e2bCreationTimeout(ownerId, 'personal', randomUUID(), 'codex', { workspaceId, runId }, 900_000), 900_000)
  assert.equal(await e2bSandboxTimeout(ownerId, sandboxId, 900_000), 900_000)
  assert.deepEqual(await receipts(), afterMismatch)
})
