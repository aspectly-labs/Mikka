// Real isolated PostgreSQL (#2934): a thread's cost is read from the ledger rows
// settlement already wrote, for every run of the chain and for nobody else.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedAgent, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('thread cost ledger read', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { readThreadCost } = await import('../lib/thread-cost')
  t.after(() => pool.end())

  const owner = await seedUser(pool, 'cost-owner')
  const teammate = await seedUser(pool, 'cost-teammate')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: teammate, role: 'member' }])
  const other = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const agent = await seedAgent(pool, owner)
  const root = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id })
  const next = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id })
  const last = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id })
  await pool.query('UPDATE agent_runs SET "continuesRunId"=$2,"createdAt"=now()+interval \'1 second\' WHERE id=$1', [next, root])
  await pool.query('UPDATE agent_runs SET "continuesRunId"=$2,"createdAt"=now()+interval \'2 seconds\' WHERE id=$1', [last, next])
  const teammateAgent = await seedAgent(pool, teammate)
  const foreign = await seedRun(pool, { userId: teammate, agentId: teammateAgent, workspaceId: workspace.id })

  let chunk = 0
  // Machine prepayments carry machineChunkId's id format; model receipts do not.
  // Settlement records the platform-funded part of a Mikka 额度 receipt; by default these were charged in full.
  const credit = (state: string, cost: number | null, source: string | null) =>
    state === 'settled' && cost !== null && source !== 'api_key' && source !== 'subscription'
  const receipt = (run: string, model: string, state: string, cost: number | null, source: string | null, tokens = [0, 0],
    platform: number | null = credit(state, cost, source) ? 0 : null) =>
    pool.query(`INSERT INTO hosted_usage (id,"workspaceId",model,state,"costMicroUsd","billingSource","usageRunId","usageThreadId","inputTokens","outputTokens","platformMicroUsd")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [model.startsWith('machine/') && source === null ? `machine:${run}:${randomUUID()}:${chunk++}` : randomUUID(),
      workspace.id, model, state, cost, source, run, root, tokens[0], tokens[1], platform])
  await receipt(root, 'claude-sonnet', 'settled', 1_200, 'credits', [1000, 200]) // purchased credit: charged
  await receipt(root, 'claude-haiku', 'settled', 4_000, 'credits', [10, 10], 4_000) // a free-message turn: the platform paid it all
  await receipt(next, 'claude-haiku', 'settled', 3_000, 'credits', [20, 20], 1_000) // legacy free credit paid part, purchased the rest
  await receipt(root, 'claude-sonnet', 'settled', 900, 'credits', [0, 0], null) // settled before funding was recorded: unknown
  await receipt(root, 'machine/cloudflare-standard-1', 'settled', 8_333, null, [0, 0], null) // a chunk of unknown funding
  await receipt(root, 'claude-sonnet', 'settled', 800, null, [500, 100]) // legacy receipt: no source means credits
  await receipt(next, 'claude-sonnet', 'unknown', null, 'credits') // provider outcome unknown: held, not free
  await receipt(next, 'claude-sonnet', 'settled', null, 'credits') // settled without a cost figure
  await receipt(next, 'gpt-5', 'settled', 300, 'api_key', [40, 10])
  await receipt(next, 'claude-opus', 'settled', null, 'subscription', [70, 30]) // subscription cost is unknown, not zero
  await receipt(root, 'claude-sonnet', 'failed', 9_999, 'credits') // released, charged nothing
  await receipt(root, 'machine/cloudflare-standard-1', 'settled', 8_334, null)
  // `last` was re-created at another size: its time has no single rate.
  await receipt(last, 'machine/cloudflare-standard-2', 'settled', 12_500, null)
  await receipt(last, 'machine/cloudflare-standard-4', 'settled', null, null) // chunk not priced yet
  await receipt(foreign, 'claude-sonnet', 'settled', 5_000, 'credits')
  // A custom API-key provider may name a model like a machine label; it is still a model call.
  await receipt(next, 'machine/cloudflare-standard-1', 'settled', 300, 'api_key', [5, 5])
  // A credits receipt under that label but without a chunk id is a model call too: only the id marks a prepayment.
  await pool.query(`INSERT INTO hosted_usage (id,"workspaceId",model,state,"costMicroUsd","billingSource","usageRunId","inputTokens","outputTokens","platformMicroUsd")
    VALUES ($1,$2,'machine/cloudflare-standard-1','settled',50,'credits',$3,2,2,0)`, [randomUUID(), workspace.id, next])
  await pool.query(`INSERT INTO thread_machine_sessions ("runId","ownerId","workspaceId","sandboxId","startedAt","endedAt",reason,source)
    VALUES ($1,$2,$3,'vm-1',now()-interval '600 seconds',now(),'paused','running_since'),
      ($4,$2,$3,'vm-2',now()-interval '120 seconds',NULL,NULL,'running_since'),
      ($5,$2,$3,'vm-3',now()-interval '60 seconds',now(),'retired','running_since')`, [root, owner, workspace.id, next, last])

  await t.test('the owner reads both columns over every run of the chain', async () => {
    const cost = await readThreadCost(pool, { ownerId: owner, workspaceId: workspace.id, runId: next, groupBy: 'thread' })
    assert.ok(cost)
    assert.equal(cost.threadId, root)
    assert.deepEqual(cost.totals.credits, { microUsd: 1_200 + 800 + 2_000 + 50 + 8_334 + 12_500, unpricedReceipts: 3 })
    assert.deepEqual(cost.totals.included, { microUsd: 600, unpricedReceipts: 1,
      bySource: { api_key: { microUsd: 600, unpricedReceipts: 0 }, subscription: { microUsd: 0, unpricedReceipts: 1 } } })
    assert.deepEqual(cost.totals.covered, { microUsd: 4_000 + 1_000, receipts: 2 })
    assert.deepEqual(cost.totals.fundingUnknown, { microUsd: 900 + 8_333, receipts: 2 })
    assert.equal(cost.models, undefined)
    assert.equal(cost.machines, undefined)
  })

  await t.test('a free-message turn is covered, purchased credit is charged, unrecorded funding is unknown', async () => {
    const solo = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id })
    await receipt(solo, 'claude-haiku', 'settled', 4_000, 'credits', [10, 10], 4_000)
    await receipt(solo, 'claude-haiku', 'settled', 1_500, 'credits', [10, 10], 0)
    await receipt(solo, 'claude-haiku', 'settled', 700, 'credits', [10, 10], null)
    const cost = await readThreadCost(pool, { ownerId: owner, workspaceId: workspace.id, runId: solo, groupBy: 'thread' })
    assert.deepEqual(cost?.totals.credits, { microUsd: 1_500, unpricedReceipts: 0 }, 'only what was charged')
    assert.deepEqual(cost?.totals.covered, { microUsd: 4_000, receipts: 1 })
    assert.deepEqual(cost?.totals.fundingUnknown, { microUsd: 700, receipts: 1 }, 'neither charged nor covered')
  })

  await t.test('grouped by model, machine chunks are not models', async () => {
    const cost = await readThreadCost(pool, { ownerId: owner, workspaceId: workspace.id, runId: root, groupBy: 'model' })
    assert.deepEqual(cost?.models?.map(row => [row.model, row.calls, row.inputTokens, row.outputTokens, row.bySource.credits.microUsd]),
      [['claude-sonnet', 5, 1500, 300, 2_000], ['claude-haiku', 2, 30, 30, 2_000], ['machine/cloudflare-standard-1', 2, 7, 7, 50],
        ['claude-opus', 1, 70, 30, 0], ['gpt-5', 1, 40, 10, 0]])
    assert.equal(cost?.models?.[0].bySource.credits.unpricedReceipts, 2)
    assert.deepEqual(cost?.models?.map(row => [row.model, row.covered, row.fundingUnknown]), [
      ['claude-sonnet', { microUsd: 0, receipts: 0 }, { microUsd: 900, receipts: 1 }],
      ['claude-haiku', { microUsd: 5_000, receipts: 2 }, { microUsd: 0, receipts: 0 }],
      ['machine/cloudflare-standard-1', { microUsd: 0, receipts: 0 }, { microUsd: 0, receipts: 0 }],
      ['claude-opus', { microUsd: 0, receipts: 0 }, { microUsd: 0, receipts: 0 }],
      ['gpt-5', { microUsd: 0, receipts: 0 }, { microUsd: 0, receipts: 0 }]])
  })

  await t.test('grouped by machine: one size is metered at its rate, no rate is guessed otherwise', async () => {
    const cost = await readThreadCost(pool, { ownerId: owner, workspaceId: workspace.id, runId: root, groupBy: 'machine' })
    const rows = new Map(cost!.machines!.map(row => [row.billing === 'metered' ? row.size : row.billing, row]))
    assert.deepEqual([...rows.keys()].sort(), ['standard-1', 'standard-2', 'standard-4', 'unbilled', 'unknown_size'])
    const small = rows.get('standard-1')!
    assert.ok(small.seconds >= 600 && small.seconds <= 601, `seconds ${small.seconds}`)
    assert.equal(small.meteredMicroUsd, Math.round(small.seconds * 100_000 / 3600)) // 4 GiB × 25_000 per GiB-hour
    assert.equal(small.chargedMicroUsd, 8_334)
    assert.deepEqual([small.coveredMicroUsd, small.fundingUnknownMicroUsd], [0, 8_333])
    const open = rows.get('unbilled')!
    assert.ok(open.seconds >= 120 && open.seconds <= 122, 'an open interval counts up to now')
    assert.equal(open.meteredMicroUsd, null)
    const resized = rows.get('unknown_size')!
    assert.ok(resized.seconds >= 60 && resized.seconds <= 61)
    assert.equal(resized.meteredMicroUsd, null)
    assert.deepEqual([rows.get('standard-2')!.chargedMicroUsd, rows.get('standard-2')!.seconds], [12_500, 0])
    assert.deepEqual([rows.get('standard-4')!.chargedMicroUsd, rows.get('standard-4')!.unpricedReceipts], [0, 1])
  })

  await t.test('another member of the workspace and another workspace read nothing', async () => {
    assert.equal(await readThreadCost(pool, { ownerId: teammate, workspaceId: workspace.id, runId: root, groupBy: 'thread' }), null)
    assert.equal(await readThreadCost(pool, { ownerId: owner, workspaceId: other.id, runId: root, groupBy: 'thread' }), null)
    assert.equal(await readThreadCost(pool, { ownerId: owner, workspaceId: workspace.id, runId: foreign, groupBy: 'thread' }), null)
    assert.equal(await readThreadCost(pool, { ownerId: owner, workspaceId: workspace.id, runId: 'not-a-uuid', groupBy: 'thread' }), null)
    assert.equal(await readThreadCost(pool, { ownerId: owner, workspaceId: workspace.id, runId: root, groupBy: 'everything' as 'thread' }), null)
  })
})
