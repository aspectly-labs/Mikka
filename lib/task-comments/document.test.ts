import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Y from 'yjs'
import { addThread, createThreadStore, replyToThread } from '@/lib/rich-text/comments-model'
import { readDocumentThreads } from '@/lib/task-activity-wake'
import { taskDiscussionEvents } from '@/lib/task-activity-timeline'
import { sniffTaskFileMediaType, taskFileDisplayPath, taskFileDownloadPath, taskInlineFileUploadPath } from '@/lib/task-attachments/contract'
import { editTaskCommentInput, isReactionEmoji, setTaskCommentReactionInput, visibleThreadMessages } from './contract'
import { deleteThreadMessage, editThreadMessage, findThreadMessage, liveMessageIds, referencedTaskFileIds } from './document'

const AT = '2026-11-25T10:00:00.000Z'
const LATER = '2026-11-25T11:00:00.000Z'
const FILE = '0f8c7b1e-5d2a-4c3b-9a1f-2e3d4c5b6a79'
const OTHER_FILE = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d'

function discussion() {
  const doc = new Y.Doc()
  addThread(doc, { id: 'discussion-1', author: 'Ann', authorUserId: 'ann', createdAt: AT, messages: [{ author: 'Ann', authorUserId: 'ann', body: 'First', at: AT }] }, 'test')
  return doc
}
const thread = (doc: Y.Doc) => readDocumentThreads(doc).find(item => item.id === 'discussion-1')

test('an edit replaces the body in place, stamps editedAt and keeps the message id and position', () => {
  const doc = discussion()
  replyToThread(doc, 'discussion-1', { id: 'reply-1', author: 'Bo', authorUserId: 'bo', body: 'Reply', at: AT })
  const located = findThreadMessage(doc, 'discussion-1', 'discussion-1-1')!
  assert.equal(located.index, 0)
  const saved = editThreadMessage(doc, located, { body: 'First, edited' }, LATER)
  assert.deepEqual([saved.id, saved.body, saved.editedAt], ['discussion-1-1', 'First, edited', LATER])
  assert.deepEqual(thread(doc)!.messages.map(message => message.id), ['discussion-1-1', 'reply-1'])
  // The same content again changes nothing (no new update, no new stamp).
  let updates = 0
  doc.on('update', () => { updates++ })
  editThreadMessage(doc, findThreadMessage(doc, 'discussion-1', 'discussion-1-1')!, { body: 'First, edited' }, '2026-11-26T00:00:00.000Z')
  assert.equal(updates, 0)
  assert.equal(findThreadMessage(doc, 'discussion-1', 'missing'), null)
  assert.equal(findThreadMessage(doc, 'missing', 'discussion-1-1'), null)
  doc.destroy()
})

test('deleting a comment with replies leaves a tombstone; deleting the last live message removes the thread', () => {
  const doc = discussion()
  replyToThread(doc, 'discussion-1', { id: 'reply-1', author: 'Bo', authorUserId: 'bo', body: 'Reply', at: AT })
  editThreadMessage(doc, findThreadMessage(doc, 'discussion-1', 'discussion-1-1')!, { body: 'With file', attachments: [{ id: FILE, name: 'a.png', size: 3, mediaType: 'image/png' }] }, LATER)
  const root = deleteThreadMessage(doc, findThreadMessage(doc, 'discussion-1', 'discussion-1-1')!, 'ann', LATER)
  assert.deepEqual(root, { result: 'tombstone', threadRemoved: false, messageIds: ['discussion-1-1'] })
  const [tombstone, reply] = thread(doc)!.messages
  assert.deepEqual([tombstone.body, tombstone.deletedAt, tombstone.deletedBy, tombstone.attachments, tombstone.editedAt], ['', LATER, 'ann', undefined, undefined])
  assert.equal(reply.body, 'Reply')
  // The tombstone is shown (the thread has a reply), as an empty, deleted comment.
  assert.deepEqual(visibleThreadMessages(thread(doc)!).map(message => message.id), ['discussion-1-1', 'reply-1'])
  const events = taskDiscussionEvents(readDocumentThreads(doc))
  assert.deepEqual(events.map(event => [event.kind, event.body, event.deleted ?? false]), [['comment', '', true], ['reply', 'Reply', false]])
  assert.deepEqual([...liveMessageIds(readDocumentThreads(doc))], ['reply-1'])
  // The last live message goes with its whole thread, tombstones included.
  const last = deleteThreadMessage(doc, findThreadMessage(doc, 'discussion-1', 'reply-1')!, 'bo', LATER)
  assert.deepEqual(last, { result: 'removed', threadRemoved: true, messageIds: ['discussion-1-1', 'reply-1'] })
  assert.deepEqual(visibleThreadMessages(thread(doc)!), [])
  doc.destroy()
})

test('a reply written offline survives concurrent deletion of the only saved comment', () => {
  const server = discussion()
  const offline = new Y.Doc()
  Y.applyUpdate(offline, Y.encodeStateAsUpdate(server))
  const before = Y.encodeStateVector(offline)
  const store = createThreadStore(server)
  replyToThread(offline, 'discussion-1', { id: 'reply', author: 'Bo', body: 'Reply', at: LATER })
  deleteThreadMessage(server, findThreadMessage(server, 'discussion-1', 'discussion-1-1')!, 'ann', LATER)
  assert.equal(store.isOpen('discussion-1'), false)
  Y.applyUpdate(server, Y.encodeStateAsUpdate(offline, before))
  Y.applyUpdate(offline, Y.encodeStateAsUpdate(server, Y.encodeStateVector(offline)))
  for (const peer of [server, offline]) {
    assert.deepEqual(visibleThreadMessages(thread(peer)!).map(message => [message.id, message.body]),
      [['discussion-1-1', ''], ['reply', 'Reply']])
  }
  assert.equal(store.isOpen('discussion-1'), true)
  store.destroy()
  server.destroy()
  offline.destroy()
})

test('a deleted reply keeps its index (wake keys stay stable) but is hidden unless a live reply answers it', () => {
  const doc = discussion()
  replyToThread(doc, 'discussion-1', { id: 'reply-1', author: 'Bo', authorUserId: 'bo', body: 'Question', at: AT })
  replyToThread(doc, 'discussion-1', { id: 'reply-2', author: 'Cy', authorUserId: 'cy', body: 'Answer', at: AT, replyToMessageId: 'reply-1' })
  replyToThread(doc, 'discussion-1', { id: 'reply-3', author: 'Bo', authorUserId: 'bo', body: 'Aside', at: AT })
  deleteThreadMessage(doc, findThreadMessage(doc, 'discussion-1', 'reply-1')!, 'bo', LATER)
  deleteThreadMessage(doc, findThreadMessage(doc, 'discussion-1', 'reply-3')!, 'bo', LATER)
  assert.deepEqual(thread(doc)!.messages.map(message => message.id), ['discussion-1-1', 'reply-1', 'reply-2', 'reply-3'])
  assert.deepEqual(visibleThreadMessages(thread(doc)!).map(message => message.id), ['discussion-1-1', 'reply-1', 'reply-2'])
  assert.deepEqual(taskDiscussionEvents(readDocumentThreads(doc)).map(event => event.messageId), ['discussion-1-1', 'reply-1', 'reply-2'])
  doc.destroy()
})

test('edited comments carry editedAt and their files into the activity events', () => {
  const doc = discussion()
  editThreadMessage(doc, findThreadMessage(doc, 'discussion-1', 'discussion-1-1')!, { body: 'Now', attachments: [{ id: FILE, name: 'a.txt', size: 1, mediaType: null }] }, LATER)
  const [event] = taskDiscussionEvents(readDocumentThreads(doc))
  assert.deepEqual([event.body, event.editedAt, event.attachments?.map(file => file.id)], ['Now', LATER, [FILE]])
  doc.destroy()
})

test('inline files are referenced by taskFile nodes, task-file links and live comments only', () => {
  const content = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'taskFile', attrs: { id: FILE.toUpperCase(), name: 'a.png' } },
    { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: `/mikka${taskFileDownloadPath('t', OTHER_FILE)}&disposition=inline` } }] },
    { type: 'text', text: 'elsewhere', marks: [{ type: 'link', attrs: { href: 'https://example.com/?id=2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e' } }] },
  ] }] }
  assert.deepEqual(referencedTaskFileIds(content, []).sort(), [FILE, OTHER_FILE].sort())
  const third = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'
  const threads = [{ id: 't', author: 'a', createdAt: AT, resolved: false, messages: [
    { id: 'm1', author: 'a', body: 'x', at: AT, attachments: [{ id: third, name: 'b', size: 1, mediaType: null }] },
    { id: 'm2', author: 'a', body: '', at: AT, deletedAt: AT, attachments: [{ id: '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a', name: 'c', size: 1, mediaType: null }] },
  ] }]
  assert.deepEqual(referencedTaskFileIds(null, threads), [third])
})

test('reactions take exactly one emoji; edits and reactions validate their input', () => {
  for (const emoji of ['👍', '❤️', '👍🏽', '👩‍💻', '🇨🇳', '1️⃣', '🎉']) assert.equal(isReactionEmoji(emoji), true, emoji)
  for (const value of ['', 'a', '👍👍', ' 👍', '👍 ', 'ok👍', '<script>', '😀'.repeat(20), 42, null]) assert.equal(isReactionEmoji(value), false, String(value))
  const ref = { taskId: FILE, threadId: 'discussion-1', messageId: 'discussion-1-1' }
  assert.equal(setTaskCommentReactionInput.safeParse({ ...ref, emoji: '🚀', reacted: true }).success, true)
  assert.equal(setTaskCommentReactionInput.safeParse({ ...ref, emoji: 'x', reacted: true }).success, false)
  assert.equal(editTaskCommentInput.parse({ ...ref, body: '  hi  ' }).body, 'hi')
  for (const bad of [{ ...ref, body: '   ' }, { ...ref, body: 'x'.repeat(2001) }, { ...ref, body: 'ok', extra: 1 },
    { ...ref, body: 'ok', attachments: [{ id: FILE, name: 'a', size: 1, mediaType: null }, { id: FILE, name: 'b', size: 1, mediaType: null }] },
    { ...ref, taskId: 'nope', body: 'ok' }]) assert.equal(editTaskCommentInput.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80))
})

test('inline task files: image types come from the bytes, and their paths share the task route', () => {
  assert.equal(sniffTaskFileMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png')
  assert.equal(sniffTaskFileMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffTaskFileMediaType(new TextEncoder().encode('GIF89a...')), 'image/gif')
  assert.equal(sniffTaskFileMediaType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp')
  assert.equal(sniffTaskFileMediaType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), null)
  assert.equal(sniffTaskFileMediaType(new Uint8Array([])), null)
  assert.equal(taskFileDisplayPath('t', FILE), `/api/tasks/t/attachments?id=${FILE}&disposition=inline`)
  assert.equal(taskInlineFileUploadPath('t', FILE), `/api/tasks/t/attachments?id=${FILE}&placement=inline`)
})
