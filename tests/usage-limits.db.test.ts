// Real isolated PostgreSQL (#2938): a subscription's usage limit and the threads it paused are read from what the
// completion path already wrote (the paused run and its run_quota_paused event), for the owner alone.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedAgent, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('usage limits: owner-only projection of quota-paused runs', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { readUsageLimits } = await import('../lib/usage-limits')
  const { runQuotaPausedEvent } = await import('../lib/coordinator-events')
  t.after(() => pool.end())

  const owner = await seedUser(pool, 'limit-owner')
  const teammate = await seedUser(pool, 'limit-teammate')
  const stranger = await seedUser(pool, 'limit-stranger')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: teammate, role: 'member' }])
  const elsewhere = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const strangers = await seedWorkspace(pool, stranger, [{ userId: stranger, role: 'admin' }])
  const claude = randomUUID(), codex = randomUUID()
  const early = '2099-01-01T10:00:00.000Z', late = '2099-01-01T15:00:00.000Z'

  // What settleQuotaExhausted writes for a run that ran out with nothing to go on with.
  const paused = async (userId: string, workspaceId: string, from: { provider: 'claude' | 'codex'; connectionId: string | null }, resetsAt: string | null, status = 'paused') => {
    const run = await seedRun(pool, { userId, agentId: await seedAgent(pool, userId), workspaceId, status })
    await pool.query(`UPDATE agent_runs SET "pauseReason"=$2,"quotaResetsAt"=$3 WHERE id=$1`, [run, status === 'paused' ? 'quota_exhausted' : null, resetsAt])
    const event = runQuotaPausedEvent({ id: run, userId, issueId: null }, from, resetsAt, 'noApiKey')
    await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","runId",payload) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5)`,
      [event.userId, event.kind, event.dedupeKey, event.runId, JSON.stringify(event.payload)])
    return run
  }
  const first = await paused(owner, workspace.id, { provider: 'claude', connectionId: claude }, early)
  const second = await paused(owner, workspace.id, { provider: 'claude', connectionId: claude }, late)
  const third = await paused(owner, workspace.id, { provider: 'codex', connectionId: codex }, null)
  // Resumed already: the event stays, the run is no longer paused.
  await paused(owner, workspace.id, { provider: 'claude', connectionId: claude }, early, 'failed')
  // A teammate's paused run in the same workspace, the owner's in another workspace, a stranger's elsewhere.
  const foreign = await paused(teammate, workspace.id, { provider: 'claude', connectionId: randomUUID() }, early)
  const other = await paused(owner, elsewhere.id, { provider: 'claude', connectionId: claude }, early)
  await paused(stranger, strangers.id, { provider: 'claude', connectionId: randomUUID() }, early)
  // A run paused for another reason is not a usage limit.
  const held = await seedRun(pool, { userId: owner, agentId: await seedAgent(pool, owner), workspaceId: workspace.id, status: 'paused' })
  await pool.query(`UPDATE agent_runs SET "pauseReason"='human_control' WHERE id=$1`, [held])

  assert.deepEqual(await readUsageLimits(pool, owner, workspace.id), [
    { provider: 'claude', connectionId: claude, resetsAt: late, pausedThreadIds: [first, second] },
    { provider: 'codex', connectionId: codex, resetsAt: null, pausedThreadIds: [third] },
  ], 'one entry per subscription; the latest reset frees them all')

  // Denials: another member of the workspace sees only their own; another workspace and a stranger see none of the owner's.
  assert.deepEqual((await readUsageLimits(pool, teammate, workspace.id)).flatMap(limit => limit.pausedThreadIds), [foreign], 'a workspace member reads only their own runs')
  assert.deepEqual((await readUsageLimits(pool, owner, elsewhere.id)).flatMap(limit => limit.pausedThreadIds), [other], 'another workspace is its own scope')
  assert.deepEqual(await readUsageLimits(pool, stranger, workspace.id), [], 'a non-member reads nothing')
  assert.deepEqual(await readUsageLimits(pool, owner, strangers.id), [], 'a foreign workspace\'s runs are not the owner\'s')
  await assert.rejects(readUsageLimits(pool, owner, 'not-a-workspace'))
})
