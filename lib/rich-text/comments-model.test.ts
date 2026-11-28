import assert from 'node:assert/strict'
import test from 'node:test'
import * as Y from 'yjs'
import {
  COMMENT_MARK,
  CommentMark,
  THREADS_FIELD,
  addThread,
  createThreadStore,
  replyToThread,
  seedThreads,
  setThreadResolved,
} from './comments-model'

test('pure Yjs comment model seeds, adds, replies, resolves, and notifies subscribers', () => {
  assert.equal(COMMENT_MARK, 'comment')
  assert.equal(THREADS_FIELD, 'threads')
  assert.equal(CommentMark.name, 'comment')

  const doc = new Y.Doc()
  const store = createThreadStore(doc)
  let notifications = 0
  const unsubscribe = store.subscribe(() => { notifications++ })

  seedThreads(doc, [{
    id: 't1',
    author: 'Alice',
    createdAt: '2026-11-23T00:00:00Z',
    messages: [{ author: 'Alice', body: 'Seed', at: '2026-11-23T00:00:00Z' }],
  }])
  assert.equal(store.isOpen('t1'), true)

  addThread(doc, {
    id: 't2',
    author: 'Bob',
    createdAt: '2026-11-23T00:01:00Z',
    messages: [{ author: 'Bob', body: 'Question', at: '2026-11-23T00:01:00Z' }],
  }, 'test')
  assert.equal(replyToThread(doc, 't2', { id: 't2-reply', author: 'Alice', body: 'Answer', at: '2026-11-23T00:02:00Z' }), true)
  assert.equal(replyToThread(doc, 't2', { id: 't2-reply', author: 'Alice', body: 'Duplicate', at: '2026-11-23T00:02:00Z' }), true)
  assert.equal(store.getSnapshot().t2.messages.length, 2)

  assert.equal(setThreadResolved(doc, 't2', true), true)
  assert.equal(store.isOpen('t2'), false)
  assert.ok(notifications >= 3)

  unsubscribe()
  store.destroy()
  doc.destroy()
})
