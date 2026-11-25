import * as Y from 'yjs'
import type { JSONContent } from '@tiptap/core'
import type { ThreadMessage, ThreadRecord } from '@/lib/task-discussion'
import { THREADS_FIELD } from '@/lib/rich-text/comment-mark'
import { isDeletedMessage, TASK_FILE_NODE, type TaskCommentAttachment } from './contract'

// Edits to a task document's discussions made by the server (app/actions/task-comments.ts).
// A thread's messages are plain values in a Y.Array; a message keeps its index for
// good, because wake keys (lib/task-activity-wake.ts) and Linear mappings name it by
// position or id. So a message is never spliced out of a thread that stays: it becomes
// a tombstone, and a thread is hidden once no live message is left in it.

/** Origin of the server's discussion edits; the editor's undo skips it. */
export const TASK_COMMENT_ORIGIN = 'task-comment'

export type LocatedMessage = { thread: Y.Map<unknown>; messages: Y.Array<ThreadMessage>; index: number; message: ThreadMessage }

export function findThreadMessage(doc: Y.Doc, threadId: string, messageId: string): LocatedMessage | null {
  const thread = doc.getMap<Y.Map<unknown>>(THREADS_FIELD).get(threadId)
  if (!(thread instanceof Y.Map) || thread.get('id') !== threadId) return null
  const messages = thread.get('messages')
  if (!(messages instanceof Y.Array)) return null
  const list = messages.toArray() as ThreadMessage[]
  const index = list.findIndex(message => message?.id === messageId)
  return index < 0 ? null : { thread, messages: messages as Y.Array<ThreadMessage>, index, message: list[index] }
}

function replace(located: LocatedMessage, next: ThreadMessage) {
  located.messages.delete(located.index, 1)
  located.messages.insert(located.index, [next])
}

/** The author's new body and files, stamped as edited. Unchanged content changes nothing. */
export function editThreadMessage(doc: Y.Doc, located: LocatedMessage, change: { body: string; attachments?: TaskCommentAttachment[] }, at: string): ThreadMessage {
  const { message } = located
  const attachments = change.attachments ?? message.attachments
  const sameFiles = JSON.stringify(attachments ?? []) === JSON.stringify(message.attachments ?? [])
  if (message.body === change.body && sameFiles) return message
  const { attachments: _previous, ...rest } = message
  const next: ThreadMessage = { ...rest, body: change.body, editedAt: at, ...(attachments?.length ? { attachments } : {}) }
  doc.transact(() => replace(located, next), TASK_COMMENT_ORIGIN)
  return next
}

export type DeletedMessage = { result: 'tombstone' | 'removed'; threadRemoved: boolean; messageIds: string[] }

/**
 * Deletes one message. While another live message stays in its thread the
 * message becomes a tombstone (no body, no files; 「评论已删除」 where the
 * thread needs it, lib/task-comments/contract.ts visibleThreadMessages);
 * otherwise the whole thread is hidden. `messageIds` are every message that no
 * longer carries content, for their reactions.
 */
export function deleteThreadMessage(doc: Y.Doc, located: LocatedMessage, by: string, at: string): DeletedMessage {
  const list = located.messages.toArray()
  const othersLive = list.some((message, index) => index !== located.index && !isDeletedMessage(message))
  const { attachments: _files, editedAt: _edited, ...kept } = located.message
  doc.transact(() => replace(located, { ...kept, body: '', deletedAt: at, deletedBy: by }), TASK_COMMENT_ORIGIN)
  // Offline replies reference this shared array. Removing the parent map would
  // discard those inserts when their client reconnects.
  if (!othersLive) return { result: 'removed', threadRemoved: true, messageIds: list.map(message => message.id) }
  return { result: 'tombstone', threadRemoved: false, messageIds: [located.message.id] }
}

/** Ids of the messages that carry content: not deleted, in a thread that still exists. */
export function liveMessageIds(threads: readonly ThreadRecord[]): Set<string> {
  return new Set(threads.flatMap(thread => thread.messages.filter(message => message && !isDeletedMessage(message)).map(message => message.id)))
}

const TASK_FILE_HREF = /\/api\/tasks\/[^/?#]+\/attachments\?(?:[^#]*&)?id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[&#]|$)/i

/**
 * Inline files the description and the live comments still show: `taskFile`
 * nodes, links to a task file's download address, and comment attachments.
 * These keep their files; any other inline file of the task expires
 * (lib/task-attachments/store.ts cleanupTaskInlineFiles).
 */
export function referencedTaskFileIds(content: JSONContent | null | undefined, threads: readonly ThreadRecord[]): string[] {
  const ids = new Set<string>()
  const visit = (node: JSONContent | undefined, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 200) return
    if (node.type === TASK_FILE_NODE && typeof node.attrs?.id === 'string') ids.add(node.attrs.id.toLowerCase())
    for (const mark of node.marks ?? []) {
      const href = mark?.type === 'link' ? mark.attrs?.href : undefined
      const match = typeof href === 'string' ? TASK_FILE_HREF.exec(href) : null
      if (match) ids.add(match[1].toLowerCase())
    }
    if (Array.isArray(node.content)) for (const child of node.content) visit(child, depth + 1)
  }
  visit(content ?? undefined, 0)
  for (const thread of threads) for (const message of thread.messages) {
    if (!message || isDeletedMessage(message) || !Array.isArray(message.attachments)) continue
    for (const file of message.attachments) if (typeof file?.id === 'string') ids.add(file.id.toLowerCase())
  }
  return [...ids].filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
}
