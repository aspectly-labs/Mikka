import assert from 'node:assert/strict'
import test from 'node:test'
import { MOBILE_COMMENT_MAX, mobileTaskCommentInput, mobileTaskEditInput, mobileTaskWriteError } from './mobile-task-edit-contract'

const STATE = '6b0f2c8e-2d5c-4a1e-9a7b-0d6f3c1e2a4b'

test('an edit names its revision and at least one change; a chosen state needs its category', () => {
  for (const body of [{ revision: 3, status: 'doing' }, { revision: 3, status: 'review', stateId: STATE }, { revision: 3, priority: 'urgent' },
    { revision: 3, assigneeId: 'user-1' }, { revision: 3, assigneeId: null }, { revision: 3, status: 'done', priority: 'low', assigneeId: 'user-1' }])
    assert.ok(mobileTaskEditInput.safeParse(body).success, JSON.stringify(body))
  for (const body of [null, {}, { revision: 3 }, { status: 'doing' }, { revision: 0, status: 'doing' }, { revision: 1.5, status: 'doing' },
    { revision: 3, stateId: STATE }, { revision: 3, status: 'started' }, { revision: 3, priority: 'p0' }, { revision: 3, assigneeId: '  ' },
    { revision: 3, status: 'doing', title: 'Renamed' }])
    assert.equal(mobileTaskEditInput.safeParse(body).success, false, JSON.stringify(body))
})

test('a comment is trimmed text up to the length Mikka keeps, with an optional client id', () => {
  assert.deepEqual(mobileTaskCommentInput.parse({ body: '  Ship it  ' }), { body: 'Ship it' })
  assert.ok(mobileTaskCommentInput.safeParse({ body: 'x'.repeat(MOBILE_COMMENT_MAX), clientId: STATE }).success)
  for (const body of [{}, { body: '   ' }, { body: 'x'.repeat(MOBILE_COMMENT_MAX + 1) }, { body: 'Hi', clientId: 'retry-1' }, { body: 'Hi', author: 'Someone' }])
    assert.equal(mobileTaskCommentInput.safeParse(body).success, false, JSON.stringify(body))
})

test('a lost revision race is 409 issueStale and a hidden or unsteerable task is 404', () => {
  assert.deepEqual(mobileTaskWriteError('issueStale'), { status: 409, error: 'issueStale' })
  assert.deepEqual(mobileTaskWriteError('issueOutdated'), { status: 409, error: 'issueStale' })
  for (const code of ['issueNotFound', 'workspaceAccessDenied', 'authRequired']) assert.deepEqual(mobileTaskWriteError(code), { status: 404, error: 'issueNotFound' })
  assert.deepEqual(mobileTaskWriteError('memberNotJoined'), { status: 400, error: 'memberNotJoined' })
  assert.deepEqual(mobileTaskWriteError('issueSaveFailed'), { status: 500, error: 'issueSaveFailed' })
})
