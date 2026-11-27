import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { Sandbox } from 'e2b'
import { Pool, type PoolClient } from 'pg'
import { startExternalServices } from '../../tests/fakes/external-services.mjs'
import { LOCAL_E2B_KEY } from '../../tests/fakes/e2b.mjs'
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
  const { canReplaceLegacyBotOperation, createPrepaidE2B, e2bCanReplaceOperation, e2bCreationTimeout, e2bInitialAllocationNeedsRecovery, recordE2BComputeSnapshot, readPaidE2BTimeout, withE2BProviderTime, verifyE2BAllocation } = await import('./e2b-compute-billing')
  const operationId = randomUUID()
  const sandboxId = `sandbox-${operationId}`
  const observe = { providerScope: 'team:fixture', inspect: async () => ({
    sandboxId, state: 'running', endAt: new Date(Date.now() + 30_000), cpuCount: 2, memoryMB: 8192,
  }) as Awaited<ReturnType<typeof Sandbox.getInfo>> }
  const resume = () => withE2BProviderTime(ownerId, sandboxId, 900_000, observe, async timeoutMs => timeoutMs)
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

  const { hostedUsage } = await import('../abuse/runtime')
  const reserve = hostedUsage.reserve.bind(hostedUsage)
  const debited = Promise.withResolvers<void>(), continueFunding = Promise.withResolvers<void>()
  const heldReceipt = t.mock.method(hostedUsage, 'reserve', async (...args: Parameters<typeof reserve>) => {
    const result = await reserve(...args)
    debited.resolve()
    await continueFunding.promise
    return result
  })
  const funding = workspaceDb.transaction(() => create())
  let first: number
  try {
    await Promise.race([debited.promise, funding.then(() => assert.fail('The reservation did not reach the commit barrier'))])
    // The competing refusal cleared its mutable payer claim after the other
    // transaction settled. The durable timestamp independently owns recovery.
    await fixture.query(`UPDATE e2b_compute_leases SET "pendingAt"=NULL,"pendingRunId"=NULL WHERE "operationId"=$1`, [operationId])
  } finally {
    continueFunding.resolve()
    try { first = await funding } finally { heldReceipt.mock.restore() }
  }
  const initial = [first, ...await Promise.all(Array.from({ length: 4 }, create))]
  await fixture.query(`UPDATE e2b_compute_leases SET "pricingVersion"='previous-list-version' WHERE "operationId"=$1`, [operationId])
  assert.equal(await create(), 300_000)
  assert.equal((await fixture.query(`SELECT "pricingVersion" FROM e2b_compute_leases WHERE "operationId"=$1`, [operationId])).rows[0].pricingVersion,
    'previous-list-version', 'replay keeps the version of the admitted allocation')
  await fixture.query(`UPDATE e2b_compute_leases SET "pricingVersion"='2026-11-26' WHERE "operationId"=$1`, [operationId])
  assert.ok(initial.every(ms => ms > 270_000 && ms <= 300_000 && ms % 1_000 === 0))
  await verifyE2BAllocation(ownerId, operationId, sandboxId, {}, { cpuCount: 2, memoryMB: 8192 })
  await fixture.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","sandboxId","snapshotId","operationId",state)
    VALUES ($1,$2,$3,$4,$5,$6,'running')`, [runId, workspaceId, ownerId, sandboxId, templates.codex.templateId, operationId])
  const { readThreadMachinePlacement } = await import('../thread-machine-view')
  const machine = await readThreadMachinePlacement(fixture, ownerId, [runId])
  assert.deepEqual(machine?.machine.cloud?.compute, { provider: 'e2b', pricingVersion: '2026-11-26', size: 'medium', cpuCount: 2, memoryMB: 8192, hourlyMicroUsd: 230400 })
  assert.equal(await readThreadMachinePlacement(fixture, 'another-owner', [runId]), null)
  const expected = (index: number, chargedRunId: string | null) => (
    { id: `machine:e2b:${operationId}:${index}`, model: 'machine/e2b-medium', state: 'settled', cost: 19_200, runId: chargedRunId, unpaid: 0 })
  assert.deepEqual(await receipts(), [expected(0, runId)])

  const { readThreadCost } = await import('../thread-cost')
  const billed = await readThreadCost(fixture, { ownerId, workspaceId, runId, groupBy: 'machine' })
  assert.deepEqual(billed?.machines?.map(({ provider, size, vcpu, ramGib, pricingVersion, pricingSource, chargedMicroUsd }) =>
    ({ provider, size, vcpu, ramGib, pricingVersion, pricingSource, chargedMicroUsd })), [{
    provider: 'e2b', size: 'medium', vcpu: 2, ramGib: 8, pricingVersion: '2026-11-26',
    pricingSource: 'e2b_provisioned_list', chargedMicroUsd: 19_200,
  }])

  await fixture.query(`UPDATE e2b_compute_leases SET "paidUntil"=now()+interval '30 seconds' WHERE "operationId"=$1`, [operationId])
  assert.ok(await readPaidE2BTimeout(ownerId, sandboxId, 900_000) < 30_000)
  const shortReviewTimeout = await withE2BProviderTime(ownerId, sandboxId, 15_000, observe, async timeoutMs => timeoutMs)
  assert.ok(shortReviewTimeout > 0 && shortReviewTimeout <= 15_000)
  assert.deepEqual(await receipts(), [expected(0, runId)], 'a short review covered by current prepayment buys no new interval')
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
  const renewed = await Promise.all(Array.from({ length: 4 }, () => resume()))
  assert.ok(renewed.every(ms => ms > 300_000 && ms <= 330_000))
  assert.deepEqual(await receipts(), [expected(0, runId), expected(1, runId)])

  await fixture.query(`UPDATE e2b_compute_leases SET "paidUntil"=now()-interval '1 second' WHERE "operationId"=$1`, [operationId])
  await assert.rejects(resume(), { code: 'e2b_limit_reached' })
  assert.deepEqual(await receipts(), [expected(0, runId), expected(1, runId)])

  const successorId = await seedRun(fixture, { userId: ownerId, agentId, workspaceId, status: 'queued' })
  await fixture.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [runId])
  await fixture.query('UPDATE thread_machines SET "runId"=$2 WHERE "runId"=$1', [runId, successorId])
  await fixture.query(`UPDATE e2b_compute_leases SET "paidUntil"=now()+interval '30 seconds',
    "pendingAt"=now(),"pendingRunId"=$2 WHERE "operationId"=$1`, [operationId, runId])
  await fixture.query(`INSERT INTO workspace_credit_grants (id,"workspaceId",points,bucket,reason,"externalId") VALUES ($1,$2,2,'purchased','test',$3)`,
    [randomUUID(), workspaceId, randomUUID()])
  assert.ok(await resume() < 30_000)
  assert.deepEqual(await receipts(), [expected(0, runId), expected(1, runId)])
  assert.ok(await resume() > 300_000)
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
        if (useConcurrently) assert.ok(await resume() > 300_000)
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

  // Crash after funding but before checking out the lifecycle connection.
  // The durable scheduler releases the unused receipt without a provider call.
  let observedDeadline = Date.now() + 30_000
  let observedState: 'running' | 'paused' = 'running'
  const recoveryInfo = t.mock.method(Sandbox, 'getInfo', async () => ({
    sandboxId, state: observedState, endAt: new Date(observedDeadline), cpuCount: 2, memoryMB: 8192,
  }) as Awaited<ReturnType<typeof Sandbox.getInfo>>)
  const renewAtProvider = t.mock.method(Sandbox, 'setTimeout', async (_id: string, duration: number) => {
    observedDeadline = Date.now() + duration
  })
  const resetRenewal = async () => {
    await fixture.query('UPDATE agent_runs SET "stopRequestedAt"=NULL WHERE id=$1', [successorId])
    await fixture.query(`UPDATE e2b_compute_leases SET "paidUntil"=now()+interval '30 seconds' WHERE "operationId"=$1`, [operationId])
    await fixture.query(`INSERT INTO workspace_credit_grants (id,"workspaceId",points,bucket,reason,"externalId") VALUES ($1,$2,2,'purchased','test',$3)`,
      [randomUUID(), workspaceId, randomUUID()])
    observedDeadline = Date.now() + 30_000
    return threadLifecycleProvider.prepareKeepAlive(sandboxId, ownerId, 900_000)
  }
  const makeRenewalDue = () => fixture.query(`UPDATE e2b_compute_leases SET "renewalReviewAt"=now()-interval '1 second',
    "renewalDispatchUntil"=now()-interval '1 second' WHERE "operationId"=$1`, [operationId])
  const { reconcileCloudMachines } = await import('../computer/reconcile')
  const { runRecoveryDueSweeps } = await import('../run-recovery-due')
  const remainingReceipt = async (index: number) => (await receipts()).find(row => row.id === expected(index, successorId).id)
  try {
    await resetRenewal()
    await makeRenewalDue()
    assert.ok((await runRecoveryDueSweeps(pool, { factoryLifecycle: false })).due.has('machines'))
    await reconcileCloudMachines(pool)
    assert.deepEqual(await remainingReceipt(5), { ...expected(5, successorId), state: 'failed', cost: 0 })
    assert.equal(renewAtProvider.mock.callCount(), 0)

    // The provider extended the VM. Roll back every write made by the lifecycle
    // APP transaction and prove the earlier durable dispatch still protects it.
    const prepared = await resetRenewal()
    await prepared.begin()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      assert.ok(await prepared.apply(client))
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    await makeRenewalDue()
    assert.ok((await runRecoveryDueSweeps(pool, { factoryLifecycle: false })).due.has('machines'))
    await reconcileCloudMachines(pool)
    assert.equal(renewAtProvider.mock.callCount(), 1)
    assert.deepEqual(await remainingReceipt(6), expected(6, successorId))
    assert.deepEqual((await fixture.query(`SELECT "renewalDispatchId","usedChunkIndex" FROM e2b_compute_leases
      WHERE "operationId"=$1`, [operationId])).rows[0], { renewalDispatchId: null, usedChunkIndex: 6 })

    // The durable dispatch flag also covers exit immediately before the HTTP
    // send. Two exact unchanged provider reads are required before release.
    const abandoned = await resetRenewal()
    await abandoned.begin()
    await makeRenewalDue()
    await reconcileCloudMachines(pool)
    assert.deepEqual(await remainingReceipt(7), expected(7, successorId))
    await fixture.query(`UPDATE e2b_compute_leases SET "renewalUnchangedAt"=now()-interval '31 seconds' WHERE "operationId"=$1`,
      [operationId])
    await makeRenewalDue()
    observedState = 'paused'
    await reconcileCloudMachines(pool)
    observedState = 'running'
    assert.deepEqual(await remainingReceipt(7), { ...expected(7, successorId), state: 'failed', cost: 0 })
    await resetRenewal()
    await fixture.query(`UPDATE e2b_compute_leases SET "paidUntil"="previousPaidUntil","chunkIndex"=7,"activeChunkIndex"="previousActiveChunkIndex",
      "pendingAt"=now()-interval '6 minutes',"pendingRunId"=$2,"renewalReviewAt"=NULL WHERE "operationId"=$1`,
    [operationId, successorId])
    assert.ok((await runRecoveryDueSweeps(pool, { factoryLifecycle: false })).due.has('machines'))
    await reconcileCloudMachines(pool)
    assert.deepEqual(await remainingReceipt(8), { ...expected(8, successorId), state: 'failed', cost: 0 })
    // Stall after the durable dispatch gate has read its deadline. A
    // concurrent sweep cannot acquire the leased row and a stale caller
    // must fail its final clock check before sending any provider request.
    const stalled = await resetRenewal()
    await stalled.begin()
    const gatedClient = await pool.connect()
    const entered = Promise.withResolvers<void>()
    const continueDispatch = Promise.withResolvers<void>()
    const clock = Date.now
    try {
      await gatedClient.query('BEGIN')
      const query = (async (sql: string, args: unknown[]) => {
        const result = await gatedClient.query(sql, args)
        if (sql.includes('AS "dispatchBefore"')) {
          entered.resolve()
          await continueDispatch.promise
        }
        return result
      }) as PoolClient['query']
      const dispatch = stalled.apply({ query })
      try {
        await Promise.race([entered.promise, dispatch.then(() => assert.fail('The gated checkout completed early'))])
        assert.equal((await fixture.query(`SELECT 1 FROM e2b_compute_leases WHERE "operationId"=$1 FOR UPDATE SKIP LOCKED`, [operationId])).rowCount, 0)
        Date.now = () => clock() + 20_000
      } finally {
        continueDispatch.resolve()
        try { assert.equal(await dispatch, null) } finally { Date.now = clock }
      }
      await gatedClient.query('ROLLBACK')
    } finally {
      gatedClient.release()
    }
    await stalled.cancel()
    assert.deepEqual(await remainingReceipt(9), { ...expected(9, successorId), state: 'failed', cost: 0 })
    assert.equal(renewAtProvider.mock.callCount(), 1)
  } finally {
    recoveryInfo.mock.restore()
    renewAtProvider.mock.restore()
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
  wrongHardware.mock.restore()
  kill.mock.restore()

  const refusedOperation = randomUUID()
  await e2bCreationTimeout(ownerId, 'team:fixture', refusedOperation, templates.codex.templateId, { workspaceId, runId }, 900_000)
  const uncertain = Object.assign(new Error('response lost'), { status: 503 })
  await assert.rejects(createPrepaidE2B(ownerId, refusedOperation, async () => { throw uncertain }), error => error === uncertain)
  assert.equal(await e2bCanReplaceOperation(fixture, ownerId, refusedOperation), false)
  const refused = Object.assign(new Error('template gone'), { status: 404 })
  await assert.rejects(createPrepaidE2B(ownerId, refusedOperation, async () => { throw refused }), error => error === refused)
  assert.equal(await e2bCanReplaceOperation(fixture, ownerId, refusedOperation), false)

  // Use the real ComputerStore and pinned E2B SDK on an APP pool with one
  // connection. Policy uses raw GET plus the existing envd bearer token.
  const policyFixture = await startExternalServices({ e2b: { commands: () => ({ exitCode: 0, stdout: '' }) } })
  const savedProviderEnv = { E2B_API_KEY: process.env.E2B_API_KEY, E2B_API_URL: process.env.E2B_API_URL,
    E2B_SANDBOX_URL: process.env.E2B_SANDBOX_URL, E2B_HTTP_VERSION: process.env.E2B_HTTP_VERSION }
  Object.assign(process.env, { E2B_API_KEY: LOCAL_E2B_KEY, E2B_API_URL: policyFixture.e2bOptions.apiUrl,
    E2B_SANDBOX_URL: policyFixture.e2bOptions.sandboxUrl, E2B_HTTP_VERSION: '1.1' })
  try {
    const policyOwner = await seedUser(fixture, 'e2b-policy')
    const { id: policyWorkspace } = await seedWorkspace(fixture, policyOwner, [{ userId: policyOwner, role: 'admin' }])
    const booted = await Sandbox.create('desktop', policyFixture.e2bOptions)
    const policyBot = randomUUID()
    await fixture.query(`INSERT INTO bots (id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,'Policy fixture')`,
      [policyBot, policyWorkspace, policyOwner])
    await fixture.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","sandboxId","operationId",state,"runtimeReady")
      VALUES ($1,$2,$3,$4,'running',true)`, [policyWorkspace, policyOwner, booted.sandboxId, randomUUID()])
    await fixture.query(`INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display) VALUES ($1,$2,$3,1)`,
      [policyBot, policyWorkspace, policyOwner])
    await fixture.query(`INSERT INTO e2b_resource_accounts (kind,id,"ownerId",scope) VALUES ('sandbox',$1,$2,'team:fixture')`,
      [booted.sandboxId, policyOwner])
    const { ComputerStore } = await import('../computer/store')
    const store = new ComputerStore(pool)
    const providerStart = policyFixture.e2b.requests.length
    const observed = policyFixture.e2b.sandboxes.get(booted.sandboxId)!
    const deadline = observed.expires
    assert.equal((await store.setPolicy(policyWorkspace, 'deny')).permission, 'deny')
    assert.equal(JSON.parse(observed.files.get('/run/mikka-viewer/1.next')!.toString()).computerAllowed, false)
    assert.equal(observed.expires, deadline)
    assert.ok(policyFixture.e2b.requests.slice(providerStart).some(request => request.path.startsWith('/e2b/envd/')))
    observed.state = 'paused'
    const pausedAt = policyFixture.e2b.requests.length
    const { observeComputerWorker } = await import('../computer/e2b-provider')
    assert.equal(await observeComputerWorker(policyWorkspace, booted.sandboxId), 'unknown')
    Object.assign(observed.metadata, { application: 'mikka', workspaceId: policyWorkspace, workerSha: 'b'.repeat(40) })
    assert.equal(await observeComputerWorker(policyWorkspace, booted.sandboxId), 'stale')
    assert.equal((await store.setPolicy(policyWorkspace, 'allow')).permission, 'allow')
    assert.equal(observed.state, 'paused')
    assert.ok(!policyFixture.e2b.requests.slice(pausedAt).some(request => request.path.startsWith('/e2b/envd/')))
    assert.ok(!policyFixture.e2b.requests.slice(providerStart).some(request => request.method === 'POST' && request.path.startsWith('/e2b/api/')))
    assert.equal((await fixture.query('SELECT count(*)::int AS n FROM hosted_usage WHERE "usageWorkspaceId"=$1', [policyWorkspace])).rows[0].n, 0)

    const priorRuntime = process.env.MIKKA_CLOUD_RUNTIME_PREVIOUS
    const priorDesktop = { ...templates.desktop, templateId: 'previous-verified-desktop' }
    const priorTemplates = { ...templates, desktop: priorDesktop }
    try {
      process.env.MIKKA_CLOUD_RUNTIME_PREVIOUS = JSON.stringify({ version: 1, configuration: {
        ...env, E2B_BYO_COMPUTER_TEMPLATE: priorDesktop.templateId,
        MIKKA_CLOUD_TEMPLATE_MODELS: JSON.stringify({ version: 1, workerSha, templates: priorTemplates }),
      } })
      observed.template = priorDesktop.templateId
      delete observed.metadata.workerSha
      assert.equal(await observeComputerWorker(policyWorkspace, booted.sandboxId), 'current',
        'a different verified template with the same worker keeps the paused desktop')
    } finally {
      if (priorRuntime === undefined) delete process.env.MIKKA_CLOUD_RUNTIME_PREVIOUS
      else process.env.MIKKA_CLOUD_RUNTIME_PREVIOUS = priorRuntime
    }

    const createdOperation = randomUUID()
    const createdWorkspace = (await seedWorkspace(fixture, policyOwner, [{ userId: policyOwner, role: 'admin' }])).id
    await fixture.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId",state) VALUES ($1,$2,$3,'waking')`,
      [createdWorkspace, policyOwner, createdOperation])
    await fixture.query(`INSERT INTO workspace_credit_grants (id,"workspaceId",points,bucket,reason,"externalId") VALUES ($1,$2,2,'purchased','test',$3)`,
      [randomUUID(), createdWorkspace, randomUUID()])
    policyFixture.e2b.state.templates.add(templates.desktop.templateId)
    const inspectReal = Sandbox.getInfo.bind(Sandbox)
    const verifiedHardware = t.mock.method(Sandbox, 'getInfo', async (...args: Parameters<typeof Sandbox.getInfo>) => ({
      ...await inspectReal(...args), cpuCount: 2, memoryMB: 8192,
    }))
    const { createComputer } = await import('../computer/e2b-provider')
    try {
      const created = await createComputer(createdWorkspace, createdOperation)
      const allocation = policyFixture.e2b.sandboxes.get(created.sandboxId)!
      assert.equal(allocation.metadata.workerSha, workerSha, 'the production create writes the verified worker to E2B')
      await fixture.query('UPDATE cloud_machines SET "sandboxId"=$1 WHERE "operationId"=$2', [created.sandboxId, createdOperation])
      allocation.state = 'paused'
      assert.equal(await observeComputerWorker(createdWorkspace, created.sandboxId), 'current')
    } finally {
      verifiedHardware.mock.restore()
    }
  } finally {
    for (const [key, value] of Object.entries(savedProviderEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await policyFixture.close()
  }

  const historicalBotOperation = randomUUID()
  await fixture.query(`INSERT INTO e2b_resource_accounts (kind,id,"ownerId",scope) VALUES ('operation',$1,$2,'team:fixture')`,
    [historicalBotOperation, ownerId])
  assert.equal(await canReplaceLegacyBotOperation(fixture, ownerId, historicalBotOperation), true)
  assert.equal(await canReplaceLegacyBotOperation(fixture, 'different-owner', historicalBotOperation), false)
  await fixture.query(`INSERT INTO e2b_resource_accounts (kind,id,"ownerId",scope) VALUES ('operation',$1,$2,'team:fixture')`,
    [operationId, ownerId])
  assert.equal(await canReplaceLegacyBotOperation(fixture, ownerId, operationId), false, 'never rotate an operation carrying a prepaid receipt')

  const legacyRun = await seedRun(fixture, { userId: ownerId, agentId, workspaceId, status: 'queued' })
  const legacyOperation = randomUUID()
  await fixture.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","snapshotId","operationId",state)
    VALUES ($1,$2,$3,$4,$5,'starting')`, [legacyRun, workspaceId, ownerId, templates.codex.templateId, legacyOperation])
  await fixture.query(`INSERT INTO e2b_resource_accounts (kind,id,"ownerId",scope) VALUES ('operation',$1,$2,'team:fixture')`,
    [legacyOperation, ownerId])
  const legacyId = `historical-${legacyOperation}`
  const legacyInfo = { sandboxId: legacyId, state: 'running', startedAt: new Date(Date.now()-5_000), endAt: new Date(Date.now()+60_000),
    cpuCount: 2, memoryMB: 8192, metadata: { application: 'mikka-thread', workspaceId, runId: legacyRun, operationId: legacyOperation } }
  const listLegacy = t.mock.method(Sandbox, 'list', () => ({ nextItems: async () => [legacyInfo], hasNext: false }) as never)
  const pauseLegacy = t.mock.method(Sandbox, 'pause', async () => true)
  try {
    const beforeLegacy = await receipts()
    assert.deepEqual(await threadLifecycleProvider.findCreated(legacyRun, workspaceId, legacyOperation, ownerId),
      { sandboxId: legacyId, state: 'paused', startedAt: legacyInfo.startedAt.getTime(), endAt: null })
    assert.equal(pauseLegacy.mock.callCount(), 1)
    assert.deepEqual(await receipts(), beforeLegacy)
  } finally {
    listLegacy.mock.restore()
    pauseLegacy.mock.restore()
  }

  const rotatedSnapshot = 'rotated-template-snapshot'
  const rotatedRun = await seedRun(fixture, { userId: ownerId, agentId, workspaceId, status: 'queued' })
  const restoreOperation = randomUUID()
  await fixture.query(`INSERT INTO e2b_resource_accounts (kind,id,"ownerId",scope) VALUES ('snapshot',$1,$2,'team:fixture')`,
    [rotatedSnapshot, ownerId])
  await recordE2BComputeSnapshot(ownerId, sandboxId, rotatedSnapshot)
  await fixture.query(`INSERT INTO workspace_credit_grants (id,"workspaceId",points,bucket,reason,"externalId") VALUES ($1,$2,2,'purchased','test',$3)`,
    [randomUUID(), workspaceId, randomUUID()])
  const restoreId = 'restored-' + restoreOperation
  const restoreCall = t.mock.method(Sandbox, 'create', async (snapshot: string) => {
    assert.equal(snapshot, rotatedSnapshot)
    return { sandboxId: restoreId } as Sandbox
  })
  const restoreInfo = t.mock.method(Sandbox, 'getInfo', async () => ({ sandboxId: restoreId, cpuCount: 2, memoryMB: 8192 } as Awaited<ReturnType<typeof Sandbox.getInfo>>))
  try {
    process.env.E2B_CODEX_TEMPLATE = 'new-codex-template'
    assert.equal((await threadLifecycleProvider.createFromSnapshot(rotatedSnapshot, restoreOperation, { workspaceId, runId: rotatedRun }, ownerId)).sandboxId, restoreId)
    const receipt = (await receipts()).find(candidate => candidate.id === `machine:e2b:${restoreOperation}:0`)
    assert.equal(receipt?.cost, 19_200)
  } finally {
    process.env.E2B_CODEX_TEMPLATE = templates.codex.templateId
    restoreCall.mock.restore()
    restoreInfo.mock.restore()
  }

  const requests: { key: string | undefined; body: string; path: string | undefined }[] = []
  const discovered: URL[] = []
  const originalApiUrl = process.env.E2B_API_URL
  t.after(() => {
    if (originalApiUrl === undefined) delete process.env.E2B_API_URL
    else process.env.E2B_API_URL = originalApiUrl
  })
  let responseStatus = 422
  const provider = createServer(async (req, res) => {
    if (req.method === 'GET') {
      if (req.url?.startsWith('/sandboxes/')) { res.writeHead(404); res.end(); return }
      discovered.push(new URL(req.url ?? '/', 'http://127.0.0.1'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('[]')
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ key: req.headers['idempotency-key'] as string | undefined, body, path: req.url })
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
  // The actual normal reconnect runs the shared durable intent around
  // the SDK's hosted control-plane POST. Policy-only never calls it.
  process.env.E2B_API_URL = `http://127.0.0.1:${address.port}`
  const { connectComputer, PolicySandboxUnavailable } = await import('../computer/e2b-provider')
  const connectInfo = t.mock.method(Sandbox, 'getInfo', observe.inspect)
  try {
    const beforePolicy = requests.length
    await assert.rejects(connectComputer(workspaceId, sandboxId, undefined, undefined, true), PolicySandboxUnavailable)
    assert.equal(requests.length, beforePolicy)
    for (const [index, status] of [[10, 403], [11, 503]] as const) {
      responseStatus = status
      await fixture.query(`UPDATE e2b_compute_leases SET "paidUntil"=now()+interval '30 seconds' WHERE "operationId"=$1`, [operationId])
      await fixture.query(`INSERT INTO workspace_credit_grants (id,"workspaceId",points,bucket,reason,"externalId") VALUES ($1,$2,2,'purchased','test',$3)`,
        [randomUUID(), workspaceId, randomUUID()])
      await assert.rejects(connectComputer(workspaceId, sandboxId))
      assert.equal(requests.at(-1)?.path, `/v2/sandboxes/${sandboxId}/connect`)
      assert.ok(JSON.parse(requests.at(-1)!.body).timeout > 300)
      assert.deepEqual(await remainingReceipt(index), status === 403
        ? { ...expected(index, successorId), state: 'failed', cost: 0 }
        : expected(index, successorId))
    }
    const sent = requests.length
    await assert.rejects(connectComputer(workspaceId, sandboxId), { code: 'e2b_limit_reached' })
    assert.equal(requests.length, sent)
  } finally {
    connectInfo.mock.restore()
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
  const existing = await withE2BProviderTime(ownerId, existingSandboxId, 900_000, {
    providerScope: 'team:fixture',
    inspect: async () => ({ sandboxId: existingSandboxId, templateId: 'retired-desktop', cpuCount: 2, memoryMB: 8192 }) as Awaited<ReturnType<typeof Sandbox.getInfo>>,
  }, async timeoutMs => timeoutMs)
  assert.ok(existing > 270_000 && existing <= 300_000)

  const afterMismatch = await receipts()
  process.env.MIKKA_EDITION = 'community'
  assert.equal(await e2bCreationTimeout(ownerId, 'personal', randomUUID(), 'codex', { workspaceId, runId }, 900_000), 900_000)
  assert.equal(await resume(), 900_000)
  assert.deepEqual(await receipts(), afterMismatch)

  await t.test('settles E2B awake seconds on pause/kill, refunds unused credits, and charges fresh chunk on resume', async () => {
    process.env.MIKKA_EDITION = 'cloud'
    const awakeOwnerId = await seedUser(fixture, 'e2b-awake-sec')
    const { id: awakeWorkspaceId } = await seedWorkspace(fixture, awakeOwnerId, [{ userId: awakeOwnerId, role: 'admin' }])
    const awakeAgentId = await seedAgent(fixture, awakeOwnerId)
    const awakeRunId = await seedRun(fixture, { userId: awakeOwnerId, agentId: awakeAgentId, workspaceId: awakeWorkspaceId, status: 'running' })
    await fixture.query(
      `INSERT INTO workspace_credit_grants (id,"workspaceId",points,bucket,reason,"externalId") VALUES ($1,$2,10,'purchased','test',$3)`,
      [randomUUID(), awakeWorkspaceId, randomUUID()],
    )
    const { hostedUsage } = await import('../abuse/runtime')
    const { recordE2BComputeSandbox, settleE2BAwakeInterval } = await import('./e2b-compute-billing')
    const op = randomUUID()
    const sb = `sb-${randomUUID()}`
    const startedAt = new Date(Date.now() - 120_000)
    await fixture.query(`INSERT INTO e2b_resource_accounts (kind,id,"ownerId",scope) VALUES ('operation',$1,$2,'team:fixture'),('sandbox',$3,$2,'team:fixture')`,
      [op, awakeOwnerId, sb])

    // Chunk 0 prepays 5 minutes of medium ($0.2304/hr = 19,200 micro-USD).
    await e2bCreationTimeout(awakeOwnerId, 'team:fixture', op, templates.codex.templateId, { workspaceId: awakeWorkspaceId, runId: awakeRunId }, 900_000,
      { provider: 'e2b', size: 'medium', hourlyMicroUsd: 230_400, pricingVersion: '2026-11-26', cpuCount: 2, memoryMB: 8192 })
    await recordE2BComputeSandbox(awakeOwnerId, op, sb, startedAt)
    assert.equal((await hostedUsage.balance(awakeWorkspaceId)).purchased, 100_000 - 19_200)

    // Pause after 60 awake seconds using an existing transaction (verifies pool.max=1 safety) -> bills 60*64=3,840, refunds 15,360.
    const pausedAt = new Date(startedAt.getTime() + 60_000)
    const pauseTx = await pool.connect()
    try {
      await pauseTx.query('BEGIN')
      const firstPause = await settleE2BAwakeInterval(awakeOwnerId, sb, pausedAt, pauseTx)
      await pauseTx.query('COMMIT')
      assert.deepEqual(firstPause, { settled: true, refundedMicroUsd: 15_360 })
    } finally {
      pauseTx.release()
    }
    assert.equal((await hostedUsage.balance(awakeWorkspaceId)).purchased, 100_000 - 3_840)

    // Repeated settlement while still paused is idempotent ($0 while sleeping).
    assert.deepEqual(await settleE2BAwakeInterval(awakeOwnerId, sb, new Date(pausedAt.getTime() + 60_000)), {
      settled: false, refundedMicroUsd: 0,
    })

    // Resume bills chunk 1 (`19,200` micro-USD); kill after 10 awake seconds leaves chunk 0 untouched and settles chunk 1 at `640` micro-USD.
    await withE2BProviderTime(awakeOwnerId, sb, 900_000, {
      providerScope: 'team:fixture',
      inspect: async () => ({ sandboxId: sb, templateId: templates.codex.templateId, cpuCount: 2, memoryMB: 8192, endAt: pausedAt }) as Awaited<ReturnType<typeof Sandbox.getInfo>>,
    }, async timeoutMs => timeoutMs)
    const leaseAfterResume = (await fixture.query<{ activeChunkIndex: number; activeChunkStartedAt: Date }>(
      `SELECT "activeChunkIndex","activeChunkStartedAt" FROM e2b_compute_leases WHERE "operationId"=$1`, [op])).rows[0]
    assert.equal(leaseAfterResume.activeChunkIndex, 1)

    const killedAt = new Date(leaseAfterResume.activeChunkStartedAt.getTime() + 10_000)
    const killSettle = await settleE2BAwakeInterval(awakeOwnerId, sb, killedAt)
    assert.deepEqual(killSettle, { settled: true, refundedMicroUsd: 18_560 })
    assert.equal((await hostedUsage.balance(awakeWorkspaceId)).purchased, 100_000 - 3_840 - 640)

    // Renewal within the lead window before previous chunk finishes: stopping early zeroes the unreached chunk (`state='failed'`)
    // AND refunds unused seconds of the active chunk.
    const preRenewOp = randomUUID()
    const preRenewSb = `sb-${randomUUID()}`
    await fixture.query(`INSERT INTO e2b_resource_accounts (kind,id,"ownerId",scope) VALUES ('operation',$1,$2,'team:fixture'),('sandbox',$3,$2,'team:fixture')`,
      [preRenewOp, awakeOwnerId, preRenewSb])
    await e2bCreationTimeout(awakeOwnerId, 'team:fixture', preRenewOp, templates.codex.templateId, { workspaceId: awakeWorkspaceId, runId: awakeRunId }, 900_000,
      { provider: 'e2b', size: 'medium', hourlyMicroUsd: 230_400, pricingVersion: '2026-11-26', cpuCount: 2, memoryMB: 8192 })
    await recordE2BComputeSandbox(awakeOwnerId, preRenewOp, preRenewSb, new Date())
    const balanceBeforeRenew = (await hostedUsage.balance(awakeWorkspaceId)).purchased
    const chunk0NearEnd = new Date(Date.now() + 20_000)
    await fixture.query(`UPDATE e2b_compute_leases SET "paidUntil"=$2,"activeChunkStartedAt"=$3 WHERE "operationId"=$1`,
      [preRenewOp, chunk0NearEnd, new Date(chunk0NearEnd.getTime() - 300_000)])
    await withE2BProviderTime(awakeOwnerId, preRenewSb, 900_000, {
      providerScope: 'team:fixture',
      inspect: async () => ({ sandboxId: preRenewSb, templateId: templates.codex.templateId, cpuCount: 2, memoryMB: 8192, endAt: chunk0NearEnd }) as Awaited<ReturnType<typeof Sandbox.getInfo>>,
    }, async timeoutMs => timeoutMs)
    const leadStopAt = new Date(chunk0NearEnd.getTime() - 10_000)
    const leadSettle = await settleE2BAwakeInterval(awakeOwnerId, preRenewSb, leadStopAt)
    assert.deepEqual(leadSettle, { settled: true, refundedMicroUsd: 19_200 + 640 })
    assert.equal((await hostedUsage.balance(awakeWorkspaceId)).purchased, balanceBeforeRenew + 640)
    const chunk1Row = (await fixture.query<{ state: string; cost: string }>(
      `SELECT state,"costMicroUsd"::text AS cost FROM hosted_usage WHERE id=$1`, [`machine:e2b:${preRenewOp}:1`])).rows[0]
    assert.deepEqual(chunk1Row, { state: 'failed', cost: '0' })

    // A stale prepareKeepAlive.cancel() / reconcile after pause must NOT revert paidUntil or activeChunkIndex.
    const lateCancelOp = randomUUID()
    const lateCancelSb = `sb-${randomUUID()}`
    await fixture.query(`INSERT INTO e2b_resource_accounts (kind,id,"ownerId",scope) VALUES ('operation',$1,$2,'team:fixture'),('sandbox',$3,$2,'team:fixture')`,
      [lateCancelOp, awakeOwnerId, lateCancelSb])
    await e2bCreationTimeout(awakeOwnerId, 'team:fixture', lateCancelOp, templates.codex.templateId, { workspaceId: awakeWorkspaceId, runId: awakeRunId }, 900_000,
      { provider: 'e2b', size: 'medium', hourlyMicroUsd: 230_400, pricingVersion: '2026-11-26', cpuCount: 2, memoryMB: 8192 })
    await recordE2BComputeSandbox(awakeOwnerId, lateCancelOp, lateCancelSb, new Date())
    const nearEnd = new Date(Date.now() + 20_000)
    await fixture.query(`UPDATE e2b_compute_leases SET "paidUntil"=$2,"activeChunkStartedAt"=$3 WHERE "operationId"=$1`,
      [lateCancelOp, nearEnd, new Date(nearEnd.getTime() - 300_000)])
    const { prepareE2BProviderTime } = await import('./e2b-compute-billing')
    const prepared = await prepareE2BProviderTime(awakeOwnerId, lateCancelSb, 900_000, {
      providerScope: 'team:fixture',
      inspect: async () => ({ sandboxId: lateCancelSb, templateId: templates.codex.templateId, cpuCount: 2, memoryMB: 8192, endAt: nearEnd }) as Awaited<ReturnType<typeof Sandbox.getInfo>>,
    })
    const settledPauseAt = new Date(nearEnd.getTime() - 10_000)
    await settleE2BAwakeInterval(awakeOwnerId, lateCancelSb, settledPauseAt)
    await prepared.cancel()
    const afterLateCancel = (await fixture.query<{ activeChunkIndex: number; lastSettledChunkIndex: number; paidUntil: Date }>(
      `SELECT "activeChunkIndex","lastSettledChunkIndex","paidUntil" FROM e2b_compute_leases WHERE "operationId"=$1`, [lateCancelOp])).rows[0]
    assert.equal(afterLateCancel.activeChunkIndex, 1)
    assert.equal(afterLateCancel.lastSettledChunkIndex, 1)
    assert.equal(afterLateCancel.paidUntil.getTime(), settledPauseAt.getTime())
  })
})
