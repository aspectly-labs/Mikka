// Real PostgreSQL: the panel/preview access rule rejects non-members and
// cross-workspace callers (#2935), keys layout by the thread's root run, and
// keeps state per viewer.
import assert from 'node:assert/strict'
import test from 'node:test'
import { dbUrl, seedAgent, seedIssue, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('thread panel access rejects outsiders and keeps layout per viewer and thread', { skip: !dbUrl, timeout: 60_000 }, async () => {
  const { pool } = await import('../lib/db')
  const { threadIssueAccess, threadPanelAccess, readThreadPanelState, writeThreadPanelState } = await import('../lib/thread-panel')
  const owner = await seedUser(pool, 'panel-owner'), member = await seedUser(pool, 'panel-member')
  const outsider = await seedUser(pool, 'panel-outsider'), suspended = await seedUser(pool, 'panel-suspended')
  const workspace = await seedWorkspace(pool, owner, [
    { userId: owner, role: 'admin' }, { userId: member, role: 'member' }, { userId: suspended, role: 'member', status: 'suspended' }])
  const foreign = await seedWorkspace(pool, outsider, [{ userId: outsider, role: 'admin' }])
  const issueId = await seedIssue(pool, owner, workspace.id)
  const foreignIssue = await seedIssue(pool, outsider, foreign.id)
  const personalIssue = await seedIssue(pool, owner)
  const agent = await seedAgent(pool, owner)
  const runA = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id, issueId })
  const runB = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id, issueId })
  const foreignRun = await seedRun(pool, { userId: outsider, agentId: await seedAgent(pool, outsider), workspaceId: foreign.id, issueId: foreignIssue })
  const personalRun = await seedRun(pool, { userId: owner, agentId: agent, issueId: personalIssue })
  const strayRun = await seedRun(pool, { userId: owner, agentId: agent })

  // Issue-level reads: members and the owner pass; suspended, outsiders and
  // cross-workspace reads are refused.
  assert.equal(await threadIssueAccess({ id: owner }, issueId), true)
  assert.equal(await threadIssueAccess({ id: member }, issueId), true)
  assert.equal(await threadIssueAccess({ id: outsider }, issueId), false)
  assert.equal(await threadIssueAccess({ id: suspended }, issueId), false)
  assert.equal(await threadIssueAccess({ id: owner }, foreignIssue), false)
  assert.equal(await threadIssueAccess({ id: outsider }, personalIssue), false)
  assert.equal(await threadIssueAccess({ id: owner }, personalIssue), true)

  // Panel rows bind run to task: a run of another task, or a missing one,
  // resolves to nothing.
  assert.equal(await threadPanelAccess({ id: owner }, issueId, runA), runA)
  assert.equal(await threadPanelAccess({ id: member }, issueId, runB), runB)
  assert.equal(await threadPanelAccess({ id: outsider }, issueId, runA), null)
  assert.equal(await threadPanelAccess({ id: owner }, foreignIssue, foreignRun), null)
  assert.equal(await threadPanelAccess({ id: owner }, issueId, foreignRun), null)
  assert.equal(await threadPanelAccess({ id: owner }, issueId, strayRun), null)
  assert.equal(await threadPanelAccess({ id: owner }, personalIssue, personalRun), personalRun)
  assert.equal(await threadPanelAccess({ id: owner }, issueId, '00000000-0000-4000-8000-000000000000'), null)

  // State is one row per viewer per thread: writes never cross members or
  // the task's two threads.
  await writeThreadPanelState(owner, runA, { tabs: ['runs'], active: 'runs', open: true })
  await writeThreadPanelState(owner, runB, { tabs: ['diff'], active: 'diff', open: true })
  await writeThreadPanelState(member, runA, { tabs: ['files', 'usage'], active: 'usage', open: false })
  assert.deepEqual(await readThreadPanelState(owner, runA), { tabs: ['runs'], active: 'runs', open: true })
  assert.deepEqual(await readThreadPanelState(owner, runB), { tabs: ['diff'], active: 'diff', open: true })
  assert.deepEqual(await readThreadPanelState(member, runA), { tabs: ['files', 'usage'], active: 'usage', open: false })
  await writeThreadPanelState(owner, runA, { tabs: [], active: '', open: false })
  assert.deepEqual(await readThreadPanelState(owner, runA), { tabs: [], active: '', open: false })
  assert.deepEqual(await readThreadPanelState(member, runA), { tabs: ['files', 'usage'], active: 'usage', open: false })

  await pool.query(`DELETE FROM thread_panel_states WHERE "runId" = ANY($1::uuid[])`, [[runA, runB]])
})
