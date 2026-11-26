import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
  const env = { MIKKA_EDITION: 'cloud', MIKKA_CLOUD_WORKER_SHA: workerSha,
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
  const { workspaceDb, workspacePool } = await import('@/lib/workspace-db')
  workspacePool.options.max = 1
  workspacePool.options.connectionTimeoutMillis = 5_000
  t.after(() => Promise.allSettled([pool.end(), workspacePool.end()]))
  const { createPrepaidE2B, e2bCanReplaceOperation, e2bCreationTimeout, e2bInitialAllocationNeedsRecovery, e2bSandboxTimeout, observeMissingE2BAllocation, verifyE2BAllocation } = await import('./e2b-compute-billing')
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
  assert.equal(await e2bCanReplaceOperation(fixture, ownerId, refusedOperation), true)

  const missingOperation = randomUUID()
  await e2bCreationTimeout(ownerId, 'team:fixture', missingOperation, templates.desktop.templateId, { workspaceId, runId: null }, 900_000)
  await fixture.query(`UPDATE e2b_compute_leases SET "paidUntil"=now()-interval '1 second' WHERE "operationId"=$1`, [missingOperation])
  assert.equal(await e2bInitialAllocationNeedsRecovery(ownerId, missingOperation), true)
  assert.equal(await observeMissingE2BAllocation(ownerId, missingOperation), false)
  assert.equal(await e2bCanReplaceOperation(fixture, ownerId, missingOperation), false)
  await fixture.query(`UPDATE e2b_compute_leases SET "creationMissingAt"=now()-interval '31 seconds' WHERE "operationId"=$1`, [missingOperation])
  assert.equal(await observeMissingE2BAllocation(ownerId, missingOperation), true)
  assert.equal(await e2bCanReplaceOperation(fixture, ownerId, missingOperation), true)

  const existingSandboxId = `existing-${randomUUID()}`
  await fixture.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId","sandboxId",state)
    VALUES ($1,$2,$3,$4,'running')`, [workspaceId, ownerId, randomUUID(), existingSandboxId])
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
