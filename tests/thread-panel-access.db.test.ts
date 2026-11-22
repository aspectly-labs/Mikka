// Real PostgreSQL: the panel/preview access rule rejects non-members and
// cross-workspace callers (#2935) and keeps state per viewer.
import assert from 'node:assert/strict'
import test from 'node:test'
import { dbUrl, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('thread panel access rejects outsiders and keeps layout per viewer', { skip: !dbUrl, timeout: 60_000 }, async () => {
  const { pool } = await import('../lib/db')
  const { threadPanelAccess, readThreadPanelState, writeThreadPanelState } = await import('../lib/thread-panel')
  const owner = await seedUser(pool, 'panel-owner'), member = await seedUser(pool, 'panel-member')
  const outsider = await seedUser(pool, 'panel-outsider'), suspended = await seedUser(pool, 'panel-suspended')
  const workspace = await seedWorkspace(pool, owner, [
    { userId: owner, role: 'admin' }, { userId: member, role: 'member' }, { userId: suspended, role: 'member', status: 'suspended' }])
  const foreign = await seedWorkspace(pool, outsider, [{ userId: outsider, role: 'admin' }])
  const issueId = await seedIssue(pool, owner, workspace.id)
  const foreignIssue = await seedIssue(pool, outsider, foreign.id)
  const personalIssue = await seedIssue(pool, owner)

  // Members and the owner pass; suspended, outsiders and cross-workspace reads are refused.
  assert.equal(await threadPanelAccess(owner, issueId), true)
  assert.equal(await threadPanelAccess(member, issueId), true)
  assert.equal(await threadPanelAccess(outsider, issueId), false)
  assert.equal(await threadPanelAccess(suspended, issueId), false)
  assert.equal(await threadPanelAccess(owner, foreignIssue), false)
  assert.equal(await threadPanelAccess(outsider, personalIssue), false)
  assert.equal(await threadPanelAccess(owner, personalIssue), true)
  assert.equal(await threadPanelAccess(owner, '00000000-0000-4000-8000-000000000000'), false)

  // State is one row per viewer: writes never cross between members.
  await writeThreadPanelState(owner, issueId, { tabs: ['runs'], active: 'runs', open: true })
  await writeThreadPanelState(member, issueId, { tabs: ['files', 'usage'], active: 'usage', open: false })
  assert.deepEqual(await readThreadPanelState(owner, issueId), { tabs: ['runs'], active: 'runs', open: true })
  assert.deepEqual(await readThreadPanelState(member, issueId), { tabs: ['files', 'usage'], active: 'usage', open: false })
  await writeThreadPanelState(owner, issueId, { tabs: [], active: '', open: false })
  assert.deepEqual(await readThreadPanelState(owner, issueId), { tabs: [], active: '', open: false })
  assert.deepEqual(await readThreadPanelState(member, issueId), { tabs: ['files', 'usage'], active: 'usage', open: false })

  await pool.query(`DELETE FROM thread_panel_states WHERE "issueId" = ANY($1::uuid[])`, [[issueId, foreignIssue, personalIssue]])
})
