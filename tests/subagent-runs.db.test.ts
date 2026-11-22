import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pool } from '../lib/db'
import { listSubagentRuns } from '../lib/subagent-runs'
import { seedAgent, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { tokenWorkspace } from '../lib/tokens/principal'

// #2939 (F): the parent's sub-agent cards — every stored field plus the shared ProfileMark state.

async function parentWithChildren() {
  const user = { id: await seedUser(pool, 'subagent'), [tokenWorkspace]: '' }
  const workspace = await seedWorkspace(pool, user.id, [{ userId: user.id, role: 'admin' }])
  user[tokenWorkspace] = workspace.id
  const agentId = await seedAgent(pool, user.id)
  const parent = await seedRun(pool, { userId: user.id, agentId, workspaceId: workspace.id, status: 'running' })
  const mkChild = async (name: string, brief: string, status: string) => {
    const id = await seedRun(pool, { userId: user.id, agentId, workspaceId: workspace.id, status })
    await pool.query(
      `UPDATE agent_runs SET "parentRunId"=$1,"threadRelation"='subagent',name=$2,profile=$3::jsonb,brief=$4 WHERE id=$5`,
      [parent, name, JSON.stringify({ icon: 'lens', color: 'teal' }), brief, id])
    return id
  }
  const running = await mkChild('检索子代理', '把线索找出来', 'running')
  const paused = await mkChild('修复子代理', '按结论改代码', 'paused')
  const finished = await mkChild('复核子代理', '读 diff 给结论', 'completed')
  // A sibling thread (no parent link) and another owner's child stay invisible.
  await seedRun(pool, { userId: user.id, agentId, workspaceId: workspace.id, status: 'running' })
  return { user, parent, running, paused, finished }
}

test('listSubagentRuns returns every card field with the shared mark state', async () => {
  const { user, parent, running, paused, finished } = await parentWithChildren()
  const cards = await listSubagentRuns(user as never, parent)
  assert.deepEqual(cards.map(card => card.id), [running, paused, finished])
  const [first, second, third] = cards
  assert.equal(first.name, '检索子代理')
  assert.deepEqual(first.profile, { icon: 'lens', color: 'teal' })
  assert.equal(first.brief, '把线索找出来')
  assert.equal(first.mark, 'working')
  assert.equal(second.mark, 'failed')
  assert.equal(third.mark, 'idle')
})

test('listSubagentRuns hides other threads and rejects other owners', async () => {
  const { user, parent } = await parentWithChildren()
  const outsider = { id: await seedUser(pool, 'subagent-out'), [tokenWorkspace]: '' }
  await assert.rejects(() => listSubagentRuns(outsider as never, parent))
})
