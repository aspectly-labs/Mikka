import assert from 'node:assert/strict'
import test from 'node:test'
import { pullWakeEvent } from './pull-request-wake'

const base = { installation: { id: 1 }, repository: { id: 2, full_name: 'org/repo' },
  pull_request: { number: 8, state: 'open', mergeable: false }, sender: { type: 'User' }, action: 'created' }
test('GitHub wake events match review comments, actual conflicts and failed suites only', () => {
  assert.equal(pullWakeEvent('pull_request_review_comment', base)?.preference, 'prWakeOnReview')
  assert.equal(pullWakeEvent('pull_request_review_comment', { ...base, sender: { type: 'Bot' } }), null)
  assert.equal(pullWakeEvent('pull_request', { ...base, action: 'synchronize' })?.preference, 'prWakeOnConflict')
  assert.equal(pullWakeEvent('pull_request', { ...base, action: 'synchronize', pull_request: { ...base.pull_request, mergeable: null } }), null)
  const pending = pullWakeEvent('pull_request', { ...base, action: 'synchronize', pull_request: { ...base.pull_request, mergeable: null, head: { sha: 'a'.repeat(40) } } })
  assert.ok(pending && 'checkConflict' in pending && pending.checkConflict)
  const check = { ...base, action: 'completed', check_suite: { id: 1, head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'failure', pull_requests: [{ number: 8 }] } }
  assert.equal(pullWakeEvent('check_suite', check)?.preference, 'prWakeOnCiFailure')
  assert.equal(pullWakeEvent('check_suite', { ...check, check_suite: { ...check.check_suite, conclusion: 'success' } }), null)
})
