import * as Y from 'yjs'
import { taskCommentAttachmentsSchema } from '@/lib/task-comments/contract'

type CommentMessage = { id: string; author: string; authorUserId?: string; body: string; editedAt?: string; deletedAt?: string; deletedBy?: string; attachments?: unknown }
/** Fields only the server writes: when a message was edited and who deleted it. */
const SERVER_OWNED = ['editedAt', 'deletedAt', 'deletedBy'] as const
/** Sets or clears one field in place, so an unchanged message keeps its key order (and is not rewritten). */
function own(message: Record<string, unknown>, key: string, value: unknown) {
  if (value === undefined) { if (key in message) delete message[key] }
  else if (message[key] !== value) message[key] = value
}
const filesKey = (value: unknown) => JSON.stringify(value ?? [])
function checkAttachments(value: unknown) {
  if (value !== undefined && !taskCommentAttachmentsSchema.safeParse(value).success) throw new Error('Invalid comment attachments')
}
type CommentThread = { author: string; authorUserId?: string; messages: Map<string, CommentMessage> }
export type CommentAuthorshipSnapshot = Map<string, CommentThread>

export function persistedCommentAuthorMatches(persisted: string | null, message: string | undefined) {
  return persisted === (message ?? null)
}

export function snapshotCommentAuthorship(doc: Y.Doc): CommentAuthorshipSnapshot {
  const snapshot: CommentAuthorshipSnapshot = new Map()
  for (const [threadId, thread] of doc.getMap<Y.Map<unknown>>('threads')) {
    if (!(thread instanceof Y.Map)) throw new Error('Invalid comment thread')
    if (thread.get('id') !== threadId) throw new Error('Invalid comment thread identity')
    const messages = thread.get('messages')
    const saved = new Map<string, CommentMessage>()
    if (messages instanceof Y.Array) {
      for (const message of messages.toArray() as CommentMessage[]) {
        if (typeof message?.id === 'string') saved.set(message.id, message)
      }
    }
    snapshot.set(threadId, {
      author: typeof thread.get('author') === 'string' ? thread.get('author') as string : '',
      authorUserId: typeof thread.get('authorUserId') === 'string' ? thread.get('authorUserId') as string : undefined,
      messages: saved,
    })
  }
  return snapshot
}

/**
 * Binds every message to who wrote it, after a client's document update. Only
 * a message's author changes its body or files (stamped `editedAt`) or deletes
 * it (a tombstone: empty body, `deletedAt`, `deletedBy`); a tombstone never
 * changes again. `editedAt`, `deletedAt` and `deletedBy` are the server's.
 */
export function bindCommentAuthorship(doc: Y.Doc, before: CommentAuthorshipSnapshot, author: { id: string; name: string }, at = new Date().toISOString()) {
  const threads = doc.getMap<Y.Map<unknown>>('threads')
  doc.transact(() => {
    for (const [threadId, previous] of before) {
      const thread = threads.get(threadId)
      if (!thread) {
        if ([...previous.messages.values()].some(message => message.authorUserId !== author.id)) throw new Error('You cannot remove another user\'s comment')
        continue
      }
      if (!(thread instanceof Y.Map) || thread.get('id') !== threadId) throw new Error('Invalid comment thread identity')
      const messages = thread.get('messages')
      if (!(messages instanceof Y.Array)) throw new Error('Invalid comment messages')
      const currentIds = new Set((messages.toArray() as CommentMessage[]).map(message => message?.id))
      if ([...previous.messages].some(([id, message]) => !currentIds.has(id) && message.authorUserId !== author.id)) throw new Error('You cannot remove another user\'s comment')
    }
    for (const [threadId, thread] of threads) {
      if (!(thread instanceof Y.Map)) throw new Error('Invalid comment thread')
      if (thread.get('id') !== threadId) throw new Error('Invalid comment thread identity')
      const messages = thread.get('messages')
      if (!(messages instanceof Y.Array)) continue
      const previous = before.get(threadId)
      const current = messages.toArray() as CommentMessage[]
      const next = current.map(message => {
        if (!message || typeof message.id !== 'string' || typeof message.author !== 'string' || typeof message.body !== 'string') throw new Error('Invalid comment message')
        const saved = previous?.messages.get(message.id)
        if (saved) {
          // A tombstone stays exactly as the server wrote it.
          if (typeof saved.deletedAt === 'string') return saved
          const mine = saved.authorUserId === author.id
          if (typeof message.deletedAt === 'string') {
            if (!mine) throw new Error('You cannot remove another user\'s comment')
            const { attachments: _files, editedAt: _edited, ...kept } = saved
            return { ...kept, body: '', deletedAt: at, deletedBy: author.id }
          }
          const changed = saved.body !== message.body || filesKey(saved.attachments) !== filesKey(message.attachments)
          if (changed && !mine) throw new Error('You cannot edit another user\'s comment')
          if (changed) checkAttachments(message.attachments)
          const attributed: CommentMessage = { ...message, author: saved.author }
          if (saved.authorUserId) attributed.authorUserId = saved.authorUserId
          else delete attributed.authorUserId
          for (const key of SERVER_OWNED) own(attributed as Record<string, unknown>, key, saved[key])
          if (changed) own(attributed as Record<string, unknown>, 'editedAt', at)
          return attributed
        }
        checkAttachments(message.attachments)
        const created: CommentMessage = { ...message, author: author.name, authorUserId: author.id }
        for (const key of SERVER_OWNED) own(created as Record<string, unknown>, key, undefined)
        return created
      })
      if (JSON.stringify(current) !== JSON.stringify(next)) {
        messages.delete(0, messages.length)
        if (next.length) messages.insert(0, next)
      }
      const displayAuthor = previous?.author ?? next[0]?.author ?? author.name
      const authorId = previous?.authorUserId ?? next[0]?.authorUserId
      if (thread.get('author') !== displayAuthor) thread.set('author', displayAuthor)
      if (authorId) thread.set('authorUserId', authorId)
      else thread.delete('authorUserId')
    }
  }, 'server-authorship')
}
