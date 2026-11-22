// getDeletedIssue's failure outcomes (#1966): access denials collapse to
// null so the detail page shows the generic unavailable view, while a
// transient failure must reject so SWR retries and the Restore card can
// come back once the blip passes.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'

test('getDeletedIssue failure outcomes', async () => {
  let failure: Error = new Error('unassigned')
  mock.module('@/lib/issue-access', { namedExports: {
    requireIssueAccess: async () => { throw failure },
    requireIssueAccessWithoutBody: async () => { throw failure },
  } })
  mock.module('@/lib/issue-scope-authorization', { namedExports: {
    requireCurrentIssueWorkspace: async () => {},
    requireLockedIssueScope: async () => { throw new Error('unused in this test') },
    withIssueWorkspace: async () => { throw new Error('unused in this test') },
  } })
  const { getDeletedIssue } = await import('../app/actions/issue-operations')
  const { ActionFailureError } = await import('../lib/action-error')
  const { WorkspaceError } = await import('../lib/workspace-error')

  failure = new ActionFailureError('issueNotFound')
  assert.equal(await getDeletedIssue(randomUUID()), null, 'issue-access denial maps to null')

  failure = new WorkspaceError('workspaceAccessDenied')
  assert.equal(await getDeletedIssue(randomUUID()), null, 'workspace denial maps to null')

  failure = new Error('database gone')
  await assert.rejects(getDeletedIssue(randomUUID()), /database gone/, 'transient failure rejects')
})
