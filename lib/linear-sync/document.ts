import 'server-only'
import { serverIssueSchema } from '@/lib/issue-editor-schema-snapshot'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'
import { THREADS_FIELD } from '@/lib/rich-text/comment-mark'
import type { ThreadMessage, ThreadRecord } from '@/lib/rich-text/comments-model'
import type { JSONContent } from '@tiptap/core'
import * as Y from 'yjs'

export function loadIssueDocument(state: string | null, content: JSONContent) {
  const doc = new Y.Doc()
  if (state) Y.applyUpdate(doc, Buffer.from(state, 'base64'))
  else prosemirrorJSONToYXmlFragment(serverIssueSchema(), content, doc.getXmlFragment('default'))
  return doc
}

export function replaceIssueDescription(doc: Y.Doc, content: JSONContent) {
  const fragment = doc.getXmlFragment('default')
  doc.transact(() => {
    if (fragment.length) fragment.delete(0, fragment.length)
    prosemirrorJSONToYXmlFragment(serverIssueSchema(), content, fragment)
  }, 'linear-sync')
}

export function readIssueThreads(doc: Y.Doc): ThreadRecord[] {
  const value = doc.getMap<Y.Map<unknown>>(THREADS_FIELD).toJSON() as Record<string, ThreadRecord>
  return Object.values(value).filter(thread => typeof thread?.id === 'string' && Array.isArray(thread.messages))
}

export function readIssueThreadMessage(doc: Y.Doc, threadId: string, messageId: string) {
  const messages = doc.getMap<Y.Map<unknown>>(THREADS_FIELD).get(threadId)?.get('messages')
  if (!(messages instanceof Y.Array)) return null
  return (messages.toArray() as ThreadMessage[]).find(message => message.id === messageId) ?? null
}

export function upsertLinearComment(doc: Y.Doc, input: { threadId: string; messageId: string; author: string; authorUserId?: string; body: string; at: string }) {
  const threads = doc.getMap<Y.Map<unknown>>(THREADS_FIELD)
  const thread = threads.get(input.threadId)
  if (!thread) {
    const record = new Y.Map<unknown>()
    const messages = new Y.Array<ThreadMessage>()
    messages.push([{ id: input.messageId, author: input.author, body: input.body, at: input.at, ...(input.authorUserId ? { authorUserId: input.authorUserId } : {}) }])
    record.set('id', input.threadId)
    record.set('author', input.author)
    record.set('createdAt', input.at)
    record.set('resolved', false)
    record.set('messages', messages)
    doc.transact(() => threads.set(input.threadId, record), 'linear-sync')
    return
  }
  const messages = thread.get('messages')
  if (!(messages instanceof Y.Array)) return
  const current = messages.toArray() as ThreadMessage[]
  const index = current.findIndex(message => message.id === input.messageId)
  const next: ThreadMessage = { id: input.messageId, author: input.author, body: input.body, at: input.at, ...(input.authorUserId ? { authorUserId: input.authorUserId } : {}) }
  doc.transact(() => {
    if (index < 0) messages.push([next])
    else {
      const previous = current[index]!
      if (previous.body !== next.body || previous.author !== next.author || (input.authorUserId && previous.authorUserId !== input.authorUserId)) {
        messages.delete(index, 1)
        messages.insert(index, [{ ...previous, ...next }])
      }
    }
  }, 'linear-sync')
}

export function encodedIssueDocument(doc: Y.Doc) {
  const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
  if (state.length > 1_400_000) throw new Error('Issue collaboration data exceeds the supported size')
  return state
}
