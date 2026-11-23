import assert from 'node:assert/strict'
import test from 'node:test'
import { ActionFailureError } from '@/lib/action-error'
import { delegateSubagent, delegationErrorCode } from './run-delegation'

test('delegationErrorCode maps the live-sibling conflict to a delegated-child error', () => {
  assert.equal(delegationErrorCode(new ActionFailureError('runAlreadyActive', { runId: 'run-9' })), 'delegated_child_active')
  assert.equal(delegationErrorCode(new ActionFailureError('runInvalid', { reason: 'delegationLimit' })), 'delegation_limit')
  // Every other expected refusal — including a finished parent — reads as unavailable.
  assert.equal(delegationErrorCode(new ActionFailureError('runInvalid', { reason: 'delegationUnavailable' })), 'delegation_unavailable')
  assert.equal(delegationErrorCode(new ActionFailureError('runInvalid', { reason: 'taskAccess' })), 'delegation_unavailable')
  assert.equal(delegationErrorCode(new ActionFailureError('agentHarnessMissing')), 'delegation_unavailable')
})

test('delegateSubagent validates the worker inputs before any admission work', async () => {
  const run = { id: 'run-1', userId: 'user-1', issueId: 'issue-1' }
  for (const input of [{}, { task: '' }, { task: '  ' }, { task: 'x' }, { task: 'x'.repeat(4001), requestKey: 'k' },
    { task: 'x', requestKey: '' }, { task: 'x', requestKey: 'k'.repeat(141) }]) {
    assert.deepEqual(await delegateSubagent(run, input), { error: 'delegation_unavailable' })
  }
})

test('delegateSubagent refuses a run with no task before any admission work', async () => {
  const run = { id: 'run-1', userId: 'user-1', issueId: null }
  assert.deepEqual(await delegateSubagent(run, { task: 'review', requestKey: 'k' }), { error: 'delegation_unavailable' })
})
