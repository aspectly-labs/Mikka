// Engine modules the Web and iOS clients share. Their acceptance tests used to sit in the
// iOS app's suite; the app moved to the private UI repository, so the engine checks them here.
import assert from 'node:assert/strict'
import test from 'node:test'
import { directoryPullRequests, pullRequestsState } from './directory-pulls'
import { acceptTaskDelivery, backlogTaskDraft } from './task-create-form'
import { isLegacyTaskInstruction } from './task-description'
import { readPresentationPages, TASK_PRESENTATION_BATCH_LIMIT } from './task-presentation-batch'
import type { IssuePullRequest } from './issue-metadata'

const pr = (url: string, state: IssuePullRequest['state']) => ({ url, state } as IssuePullRequest)

test('one GitHub pull request delivered in several conversations is one directory row, filtered by state', () => {
  const a = { id: 'a', pulls: [pr('https://github.com/o/r/pull/1', 'open'), pr('https://github.com/o/r/pull/2', 'merged')] }
  const b = { id: 'b', pulls: [pr('https://GitHub.com/o/r/pull/1/', 'open')] }
  const all = directoryPullRequests([a, b], 'all')
  assert.deepEqual(all.map(row => [row.pull.url, row.conversations.map(c => c.id)]),
    [['https://github.com/o/r/pull/1', ['a', 'b']], ['https://github.com/o/r/pull/2', ['a']]])
  assert.deepEqual(directoryPullRequests([a, b], 'merged').map(row => row.conversations.map(c => c.id)), [['a']])
  assert.deepEqual(directoryPullRequests([a, b], 'draft'), [])
  assert.equal(pullRequestsState([{ state: 'merged' }, { state: 'draft' }]), 'draft')
  assert.equal(pullRequestsState([]), 'closed')
})

test('the shared task form makes the same backlog item and accepts its receipt once', async () => {
  const draft = backlogTaskDraft('', '第一行\n\n第二行', 'doing')
  assert.equal(draft.title, '第一行')
  assert.equal(draft.status, 'doing')
  assert.equal(draft.priority, 'normal')
  assert.deepEqual(draft.content, { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '第一行' }] }, { type: 'paragraph' },
    { type: 'paragraph', content: [{ type: 'text', text: '第二行' }] },
  ] })
  assert.equal(backlogTaskDraft('标题', '', 'unknown' as never).status, 'todo')
  const sent: string[] = []
  const operation: { id: string; delivered?: true } = { id: 'op-1' }
  await assert.rejects(acceptTaskDelivery(operation, async () => { throw new Error('lost response') }))
  assert.equal(operation.delivered, undefined, 'a lost response retries with the same identity')
  await acceptTaskDelivery(operation, async id => { sent.push(id) })
  await acceptTaskDelivery(operation, async id => { sent.push(id) })
  assert.deepEqual(sent, ['op-1'])
})

test('an old machine contract stored as a description is recognised locally', () => {
  assert.equal(isLegacyTaskInstruction('x'.repeat(1000) + ' sha-256 '), true)
  assert.equal(isLegacyTaskInstruction('文件契约' + 'x'.repeat(996)), true)
  assert.equal(isLegacyTaskInstruction('sha256'), false, 'a short description is a person\'s text')
  assert.equal(isLegacyTaskInstruction('x'.repeat(1200)), false)
})

test('task presentations are read 200 distinct tasks a page and refuse another workspace', async () => {
  const ids = Array.from({ length: 450 }, (_, i) => 't' + (i % 401))
  const pages: number[] = []
  const items = await readPresentationPages('w1', ids, async ({ workspaceId, issueIds }) => {
    pages.push(issueIds.length)
    return { version: 1, workspaceId, items: Object.fromEntries(issueIds.filter(id => id !== 't7').map(id => [id, id.toUpperCase()])) }
  })
  assert.equal(TASK_PRESENTATION_BATCH_LIMIT, 200)
  assert.deepEqual(pages, [200, 200, 1])
  assert.equal(items.size, 400)
  assert.equal(items.get('t1'), 'T1')
  assert.equal(items.has('t7'), false)
  assert.equal((await readPresentationPages('w1', [], async () => { throw new Error('no request') })).size, 0)
  await assert.rejects(readPresentationPages('w1', ['t1'], async ({ issueIds }) => ({ version: 1, workspaceId: 'w2', items: { [issueIds[0]!]: 1 } })),
    /taskPresentationScopeMismatch/)
})
