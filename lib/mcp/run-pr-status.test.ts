import assert from 'node:assert/strict'
import test from 'node:test'
import { projectRunPrStatus } from './run-pr-status'
import { reviewCheckDetails } from '@/lib/github/review-checks'

const headSha = 'a'.repeat(40)
const otherSha = 'b'.repeat(40)
const checks = {
  headSha, complete: true, updatedAt: '2026-11-21T10:00:00Z',
  entries: {
    [JSON.stringify(['check', 1, 2, 'build / test'])]: { id: 10, state: 'passed' as const, at: '2026-11-21T09:58:00Z' },
    [JSON.stringify(['check', 1, 2, 'lint'])]: { id: 11, state: 'failed' as const, at: '2026-11-21T09:59:00Z' },
    [JSON.stringify(['status', 'deploy/preview'])]: { id: 12, state: 'pending' as const, at: '2026-11-21T09:59:30Z' },
  },
}

test('projectRunPrStatus reports the assigned branch, bound pull request and check rollup from the publication record', () => {
  const status = projectRunPrStatus({
    issueId: 'issue-1',
    publication: {
      branch: 'mikka/mik-1', baseBranch: 'main', identifier: 'MIK-1', status: 'published', errorCode: null,
      pullRequest: { url: 'https://github.com/owner/repo/pull/42', state: 'open', branch: 'mikka/mik-1', headSha, title: 'Fix it', reviewChecks: checks },
    },
    taskPullRequests: [{ url: 'https://github.com/owner/repo/pull/42', state: 'open' }],
  })
  assert.equal(status.branch, 'mikka/mik-1')
  assert.equal(status.baseBranch, 'main')
  assert.deepEqual(status.pullRequest, {
    url: 'https://github.com/owner/repo/pull/42', number: 42, state: 'open', branch: 'mikka/mik-1',
    headSha, title: 'Fix it', author: null, createdAt: null,
  })
  assert.equal(status.checks?.headSha, headSha)
  assert.equal(status.checks?.complete, true)
  assert.deepEqual(status.checks?.counts, { passed: 1, failed: 1, pending: 1, skipped: 0 })
  assert.deepEqual(status.checks?.entries.map(entry => entry.name).sort(), ['build / test', 'deploy/preview', 'lint'])
  // Internal app/suite/check ids never leave the record.
  assert.equal(JSON.stringify(status.checks).includes('"id"'), false)
  assert.deepEqual(status.taskPullRequests, [{ url: 'https://github.com/owner/repo/pull/42', number: 42, state: 'open', title: null }])
})

test('projectRunPrStatus reports unknown state honestly when the run has no publication or the snapshot is stale', () => {
  const empty = projectRunPrStatus({ issueId: 'issue-1' })
  assert.equal(empty.branch, null)
  assert.equal(empty.publication, null)
  assert.equal(empty.pullRequest, null)
  assert.equal(empty.checks, null)
  assert.deepEqual(empty.taskPullRequests, [])
  const stale = projectRunPrStatus({
    issueId: 'issue-1',
    publication: {
      branch: 'mikka/mik-1', baseBranch: 'main', identifier: 'MIK-1', status: 'published', errorCode: null,
      pullRequest: { url: 'https://github.com/owner/repo/pull/42', state: 'open', headSha: otherSha, reviewChecks: checks },
    },
  })
  // The persisted snapshot covers a different head: unknown, not a stale green.
  assert.equal(stale.checks, null)
  const incomplete = projectRunPrStatus({
    issueId: 'issue-1',
    publication: {
      branch: 'mikka/mik-1', baseBranch: 'main', identifier: 'MIK-1', status: 'published', errorCode: null,
      pullRequest: { url: 'https://github.com/owner/repo/pull/42', state: 'open', headSha, reviewChecks: { ...checks, complete: false } },
    },
  })
  assert.equal(incomplete.checks?.complete, false)
  assert.equal(incomplete.checks?.counts, null)
  assert.equal(incomplete.checks?.entries.length, 3)
})

test('projectRunPrStatus defensively rejects malformed pull request fields instead of fabricating them', () => {
  const status = projectRunPrStatus({
    issueId: 'issue-1',
    publication: {
      branch: null, baseBranch: 'main', identifier: null, status: 'pending', errorCode: 'github_unavailable',
      pullRequest: { url: 5, state: 'open', headSha: 'not-a-sha', reviewChecks: 'garbage' },
    },
    taskPullRequests: [{ url: 'not-a-url' } as never, null as never],
  })
  assert.equal(status.pullRequest, null)
  assert.equal(status.checks, null)
  assert.deepEqual(status.taskPullRequests, [{ url: 'not-a-url', number: null, state: 'open', title: null }])
})

test('reviewCheckDetails projects names and states without internal ids and bounds the entry list', () => {
  const details = reviewCheckDetails(checks, headSha, 2)
  assert.equal(details?.headSha, headSha)
  assert.equal(details?.complete, true)
  assert.deepEqual(details?.counts, { passed: 1, failed: 1, pending: 1, skipped: 0 })
  assert.equal(details?.entries.length, 2)
  assert.deepEqual(details?.entries.map(entry => entry.name), ['build / test', 'deploy/preview'])
})

test('reviewCheckDetails returns null for an unknown head or a malformed snapshot', () => {
  assert.equal(reviewCheckDetails(checks, otherSha), null)
  assert.equal(reviewCheckDetails(checks, null), null)
  assert.equal(reviewCheckDetails({ headSha }, headSha), null)
})
