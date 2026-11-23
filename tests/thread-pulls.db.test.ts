import test from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../lib/db'
import { drainThreadPullMergeIntents, listThreadPulls, setThreadPullMergeIntent } from '../lib/thread-pulls'
import { seedAgent, seedIssue, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

const PULL = 'https://github.com/example/one/pull/42'

async function runWithPull() {
  const userId = await seedUser(pool, 'thread-pulls')
  const ws = await seedWorkspace(pool, userId, [{ userId, role: 'admin' }])
  const agent = await seedAgent(pool, userId)
  const issue = await seedIssue(pool, userId, ws.id)
  const run = await seedRun(pool, { userId, agentId: agent, workspaceId: ws.id, issueId: issue })
  await pool.query(
    `INSERT INTO run_publications ("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest")
     VALUES ($1,$2,$3,$4,$5,'published',$6::jsonb)`,
    [run, userId, issue, 'https://github.com/example/one.git', 'github.com/example/one',
      JSON.stringify({ url: PULL, title: 'One pull', state: 'open', headSha: 'a'.repeat(40) })])
  return { userId, workspaceId: ws.id, issueId: issue, runId: run }
}

test('listThreadPulls returns the published pull parsed off its receipt', async () => {
  const { userId, runId, issueId } = await runWithPull()
  const pulls = await listThreadPulls(pool, userId, [runId])
  assert.equal(pulls.length, 1)
  assert.equal(pulls[0]!.repo, 'example/one')
  assert.equal(pulls[0]!.number, 42)
  assert.equal(pulls[0]!.url, PULL)
  assert.equal(pulls[0]!.state, 'open')
  assert.equal(pulls[0]!.issueId, issueId)
  assert.equal(pulls[0]!.autoMerge, false)
  assert.equal(pulls[0]!.mergeIntentState, null)
})

test('arm and clear the merge intent on a published pull', async () => {
  const { userId, workspaceId, issueId, runId } = await runWithPull()
  const armed = await setThreadPullMergeIntent(pool, userId, workspaceId, issueId, runId,
    { repo: 'example/one', number: 42, headSha: 'a'.repeat(40), enabled: true })
  assert.equal(armed, 'armed')
  let pulls = await listThreadPulls(pool, userId, [runId])
  assert.equal(pulls[0]!.autoMerge, true)
  assert.equal(pulls[0]!.mergeIntentState, 'armed')
  const cleared = await setThreadPullMergeIntent(pool, userId, workspaceId, issueId, runId,
    { repo: 'example/one', number: 42, headSha: 'a'.repeat(40), enabled: false })
  assert.equal(cleared, 'cancelled')
  pulls = await listThreadPulls(pool, userId, [runId])
  assert.equal(pulls[0]!.autoMerge, false)
  assert.equal(pulls[0]!.mergeIntentState, 'cancelled')
})

test('an intent cannot be planted on a pull the thread never published', async () => {
  const { userId, workspaceId, issueId, runId } = await runWithPull()
  const state = await setThreadPullMergeIntent(pool, userId, workspaceId, issueId, runId,
    { repo: 'example/two', number: 7, headSha: 'b'.repeat(40), enabled: true })
  assert.equal(state, null)
  const { rows } = await pool.query('SELECT 1 FROM thread_pull_merge_intents WHERE "runId"=$1', [runId])
  assert.equal(rows.length, 0)
})

test('another owner sees no pulls and no armed intents on the thread', async () => {
  const { userId, workspaceId, issueId, runId } = await runWithPull()
  await setThreadPullMergeIntent(pool, userId, workspaceId, issueId, runId,
    { repo: 'example/one', number: 42, headSha: 'a'.repeat(40), enabled: true })
  const outsider = await seedUser(pool, 'thread-pulls-out')
  assert.equal((await listThreadPulls(pool, outsider, [runId])).length, 0)
  assert.equal((await drainThreadPullMergeIntents(pool, outsider, [runId])).length, 0)
  // And the armed owner's drain is the only path that touches it — an
  // empty-run drain for the real owner still touches nothing here.
  assert.equal((await drainThreadPullMergeIntents(pool, userId, [])).length, 0)
})
