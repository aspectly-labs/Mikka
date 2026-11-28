// Engine modules shared across Web and iOS clients. Their acceptance tests used to sit in
// the retired legacy apps/mobile suite; the engine verifies all shared contracts here.
import assert from 'node:assert/strict'
import test from 'node:test'
import { directoryPullRequests, pullRequestsState } from './directory-pulls'
import { namedConversationModelBot } from './named-conversation-model'
import { acceptTaskDelivery, backlogTaskDraft } from './task-create-form'
import { isLegacyTaskInstruction } from './task-description'
import { readPresentationPages, TASK_PRESENTATION_BATCH_LIMIT } from './task-presentation-batch'
import type { ChatDelivery, ChatSubmission } from './hooks/chat-delivery-state'
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

test('namedConversationModelBot selects a single owned responding Bot and declines ambiguous or unowned targets', () => {
  const members = [
    { id: 'u1', name: 'Alex', memberType: 'user' as const },
    { id: 'b1', name: 'Alpha', memberType: 'bot' as const },
    { id: 'b2', name: 'Beta', memberType: 'bot' as const },
  ]
  const owned = [{ id: 'b1' }]
  assert.equal(namedConversationModelBot(null, members, owned, '@Alpha hi'), undefined)
  assert.equal(namedConversationModelBot('ws-1', members, owned, ''), undefined, 'two bots without mention are ambiguous')
  assert.equal(namedConversationModelBot('ws-1', members, owned, '@Alpha hi'), 'b1')
  assert.equal(namedConversationModelBot('ws-1', members, owned, '@Beta hi'), undefined, 'unowned bot is excluded')
  assert.equal(namedConversationModelBot('ws-1', members.slice(0, 2), owned, ''), 'b1')
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

test('useChatDeliveryState journals immutable sends, marks interrupted rows failed, and retries safely', async () => {
  const { Window } = await import('happy-dom')
  const browser = new Window()
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement, useState } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useChatDeliveryState } = await import('./hooks/chat-delivery-state')

  type Row = ChatSubmission & { attachment?: string }
  let delivery!: ReturnType<typeof useChatDeliveryState<Row>>
  function Probe() {
    const [rows, setRows] = useState<ChatDelivery<Row>[]>([
      { id: 'interrupted-1', text: 'before reload', at: 1, phase: 'sending' },
    ])
    delivery = useChatDeliveryState(rows, setRows, 'unconfirmed')
    return null
  }
  const root = createRoot(document.body)
  try {
    await act(async () => { root.render(createElement(Probe)) })
    assert.deepEqual(delivery.rows.map(row => [row.id, row.phase, row.error]), [['interrupted-1', 'failed', 'unconfirmed']])
    const first: Row = { id: 'msg-1', text: '你好', at: 2 }
    const second: Row = { id: 'msg-2', text: '', at: 3, attachment: 'photo-1' }
    await act(async () => {
      assert.equal(delivery.begin(first), true)
      assert.equal(delivery.begin(first), false, 'duplicate in-flight submission is ignored')
      assert.equal(delivery.begin(second), true)
    })
    await act(async () => {
      delivery.finish(first.id, { error: 'offline' })
      delivery.finish(second.id, { error: 'offline' })
    })
    assert.deepEqual(delivery.rows.slice(1).map(row => [row.text, row.phase, row.attachment]), [['你好', 'failed', undefined], ['', 'failed', 'photo-1']])
    await act(async () => {
      assert.equal(delivery.begin(first), true)
      delivery.finish(first.id, { storedId: 'stored-1' })
    })
    assert.equal(delivery.rows.find(row => row.id === first.id)?.phase, 'accepted')
    assert.equal(delivery.rows.find(row => row.id === first.id)?.storedId, 'stored-1')
  } finally {
    await act(async () => { root.unmount() })
    await browser.happyDOM.close()
  }
})

test('useTaskContinuation loads next cursor once, deduplicates items, and discards previous pages on epoch change', async () => {
  const { Window } = await import('happy-dom')
  const browser = new Window()
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useTaskContinuation } = await import('./hooks/use-task-continuation')

  type Item = { id: string }
  const calls: string[] = []
  let state!: ReturnType<typeof useTaskContinuation<Item, string>>
  function Probe({ first, epoch, cursor }: { first: Item[]; epoch: string; cursor: string | null }) {
    state = useTaskContinuation<Item, string>(first, epoch, cursor, async after => {
      calls.push(after)
      return { items: [{ id: 't1' }, { id: 't2' }], next: null }
    })
    return null
  }
  const root = createRoot(document.body)
  try {
    await act(async () => { root.render(createElement(Probe, { first: [{ id: 't1' }], epoch: 'view-1', cursor: 'cursor-1' })) })
    assert.equal(state.hasMore, true)
    assert.deepEqual(state.items.map(item => item.id), ['t1'])
    await act(async () => { await state.loadMore() })
    assert.deepEqual(calls, ['cursor-1'])
    assert.equal(state.hasMore, false)
    assert.deepEqual(state.items.map(item => item.id), ['t1', 't2'])
    await act(async () => { root.render(createElement(Probe, { first: [{ id: 't9' }], epoch: 'view-2', cursor: 'cursor-2' })) })
    assert.equal(state.hasMore, true)
    assert.deepEqual(state.items.map(item => item.id), ['t9'])
  } finally {
    await act(async () => { root.unmount() })
    await browser.happyDOM.close()
  }
})
