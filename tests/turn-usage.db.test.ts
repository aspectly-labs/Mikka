// Real isolated PostgreSQL (#2934 item 5): a turn's model calls are read by the turn reference written at call
// time, for the reader who made or ran them, in their workspace.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('turn usage read', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { readTurnUsage } = await import('../lib/turn-usage')
  const { eveTurnRef, groupTurnRef } = await import('../lib/usage-turn-ref')
  t.after(() => pool.end())

  const owner = await seedUser(pool, 'turn-owner')
  const teammate = await seedUser(pool, 'turn-teammate')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: teammate, role: 'member' }])
  const other = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const bot = eveTurnRef(randomUUID(), randomUUID())!
  const group = groupTurnRef(randomUUID())!
  const theirs = groupTurnRef(randomUUID())!
  // payer: the workspace whose balance paid (a member's personal one with shared credits); usage: where it was used.
  const receipt = (values: { ref: string | null; actor: string | null; owner?: string; workspaceId?: string; payer?: string; model?: string; state?: string; cost: number | null; source: string | null; tokens: [number, number]; id?: string }) =>
    pool.query(`INSERT INTO hosted_usage (id,"workspaceId","usageWorkspaceId","actorId","executionOwnerId",model,state,"costMicroUsd","billingSource","usageTurnRef","inputTokens","outputTokens")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [values.id ?? randomUUID(), values.payer ?? values.workspaceId ?? workspace.id, values.workspaceId ?? workspace.id,
      values.actor, values.owner ?? values.actor, values.model ?? 'claude-sonnet', values.state ?? 'settled', values.cost, values.source, values.ref, values.tokens[0], values.tokens[1]])

  // One Bot chat turn: three calls, one still pending, one released.
  await receipt({ ref: bot, actor: owner, cost: 1_000, source: 'credits', tokens: [100, 10] })
  await receipt({ ref: bot, actor: owner, cost: 500, source: null, tokens: [50, 5], model: 'claude-haiku' })
  await receipt({ ref: bot, actor: owner, state: 'failed', cost: 9_999, source: 'credits', tokens: [9, 9] })
  await receipt({ ref: bot, actor: owner, id: `machine:${randomUUID()}:${randomUUID()}:0`, cost: 16_667, source: null, tokens: [0, 0], model: 'machine/cloudflare-standard-3' })
  // A group turn on an own API key, with one call the provider has not priced.
  await receipt({ ref: group, actor: owner, cost: 300, source: 'api_key', tokens: [30, 3], model: 'gpt-5' })
  await receipt({ ref: group, actor: owner, state: 'unknown', cost: null, source: 'api_key', tokens: [0, 0], model: 'gpt-5' })
  // A group turn a teammate started, and one of the owner's turns in another workspace.
  await receipt({ ref: theirs, actor: teammate, cost: 700, source: 'credits', tokens: [7, 7] })
  await receipt({ ref: bot, actor: owner, workspaceId: other.id, cost: 4_000, source: 'credits', tokens: [4, 4] })
  // Paid from the owner's shared personal credits for a team chat: the owner still sees it in the team.
  const personal = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const shared = groupTurnRef(randomUUID(), randomUUID())!
  await receipt({ ref: shared, actor: owner, payer: personal.id, cost: 250, source: 'credits', tokens: [25, 2] })
  // A call that ran for the owner with no separate actor recorded.
  const ran = eveTurnRef(randomUUID(), 'turn_2')!
  await receipt({ ref: ran, actor: null, owner, cost: 90, source: 'credits', tokens: [9, 1] })
  // Refused before its request started: settled at 0 with no tokens, not a call.
  await receipt({ ref: ran, actor: owner, cost: 0, source: 'credits', tokens: [0, 0] })
  // A receipt from before turns were recorded: never attached to any turn.
  await receipt({ ref: null, actor: owner, cost: 8_000, source: 'credits', tokens: [8, 8] })

  await t.test('each turn sums the calls made for it', async () => {
    const usage = await readTurnUsage(pool, { readerId: owner, workspaceId: workspace.id, refs: [bot, group, theirs, 'not a ref', bot] })
    assert.deepEqual(Object.keys(usage).sort(), [bot, group].sort())
    assert.deepEqual(usage[bot], { models: ['claude-sonnet', 'claude-haiku'], calls: 2, inputTokens: 150, outputTokens: 15, costMicroUsd: 1_500, unpricedCalls: 0, source: 'credits' })
    assert.deepEqual(usage[group], { models: ['gpt-5'], calls: 2, inputTokens: 30, outputTokens: 3, costMicroUsd: 300, unpricedCalls: 1, source: 'api_key' })
  })

  await t.test('shared credits and calls run for the reader count; a refused call does not', async () => {
    const usage = await readTurnUsage(pool, { readerId: owner, workspaceId: workspace.id, refs: [shared, ran] })
    assert.deepEqual([usage[shared]?.costMicroUsd, usage[shared]?.calls], [250, 1])
    assert.deepEqual([usage[ran]?.costMicroUsd, usage[ran]?.calls], [90, 1])
    assert.deepEqual(await readTurnUsage(pool, { readerId: owner, workspaceId: personal.id, refs: [shared] }), {}, 'the paying workspace is not where it was used')
    assert.deepEqual(await readTurnUsage(pool, { readerId: teammate, workspaceId: workspace.id, refs: [shared, ran] }), {})
  })

  await t.test('only the person who made the calls reads them, only in that workspace', async () => {
    assert.deepEqual(Object.keys(await readTurnUsage(pool, { readerId: teammate, workspaceId: workspace.id, refs: [bot, group, theirs] })), [theirs])
    assert.deepEqual(Object.keys(await readTurnUsage(pool, { readerId: owner, workspaceId: other.id, refs: [bot] })), [bot])
    assert.equal((await readTurnUsage(pool, { readerId: owner, workspaceId: other.id, refs: [bot] }))[bot].costMicroUsd, 4_000)
  })

  await t.test('no reference, no read', async () => {
    assert.deepEqual(await readTurnUsage(pool, { readerId: owner, workspaceId: workspace.id, refs: [] }), {})
    assert.deepEqual(await readTurnUsage(pool, { readerId: owner, workspaceId: workspace.id, refs: ['eve:', 'run:x y', "group:a'b"] }), {})
  })

  await t.test('the column refuses a malformed reference', async () => {
    await assert.rejects(receipt({ ref: 'thread:abc', actor: owner, cost: 1, source: 'credits', tokens: [1, 1] }), /check constraint/)
  })
})
