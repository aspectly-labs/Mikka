import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CitationSource } from './coordinator/citations'
import { PULL_CHIP_TONES, citedPullRequest, pullChipState } from './pull-chip'

const url = 'https://github.com/alexj11324/Mikka/pull/2837'

test('a PR chip takes its colour from the PR state and, while open, from its checks', () => {
  assert.equal(pullChipState('merged'), 'merged')
  assert.equal(pullChipState('closed'), 'closed')
  assert.equal(pullChipState('draft'), 'draft')
  assert.equal(pullChipState('open', { failed: 1, passed: 4, pending: 1 }), 'failed')
  assert.equal(pullChipState('open', { failed: 0, passed: 4, pending: 1 }), 'pending')
  assert.equal(pullChipState('open', { failed: 0, passed: 4, pending: 0 }), 'ready')
})

test('without a known state or settled checks the chip has no state colour, never a guess', () => {
  assert.equal(pullChipState(undefined), null)
  assert.equal(pullChipState('open'), null)
  assert.equal(pullChipState('open', null), null)
  assert.equal(pullChipState('open', { failed: 0 }), null)
})

test('the colours are the design tokens the issue names', () => {
  assert.deepEqual(PULL_CHIP_TONES, {
    ready: 'text-success-foreground', pending: 'text-warning-foreground', draft: 'text-muted-foreground',
    merged: 'text-github-pr-merged', closed: 'text-destructive-foreground', failed: 'text-destructive-foreground',
  })
})

test('a reply\'s PR link reads its state from the tasks and threads the chat already looked up', () => {
  const review = { pr: { number: 2837, url, state: 'open' }, checks: { passed: 6, failed: 0, pending: 0 } }
  const issue = { kind: 'issue', id: 'i1', number: 1, identifier: 'MIK-1', title: 'Task', status: 'review', priority: 'none',
    pullRequests: [{ url: url + '/', state: 'open' }], review } as unknown as CitationSource
  assert.deepEqual(citedPullRequest(url, { i1: issue }), { state: 'open', checks: review.checks })
  const run = { kind: 'run', id: 'r1', issue: { id: 'i2', review: null }, pullRequests: [{ url: url.toUpperCase().replace('HTTPS://GITHUB.COM', 'https://github.com'), state: 'merged' }] } as unknown as CitationSource
  assert.deepEqual(citedPullRequest(url, { r1: run }), { state: 'merged', checks: null })
  assert.equal(citedPullRequest(url, {}), null)
  assert.equal(citedPullRequest('https://github.com/alexj11324/Mikka/pull/1', { i1: issue }), null)
})
