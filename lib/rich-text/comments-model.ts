import * as Y from 'yjs'
import type { ThreadMessage, ThreadRecord } from '@/lib/task-discussion'
import { THREADS_FIELD } from './comment-mark'

export { CommentMark, COMMENT_MARK, THREADS_FIELD } from './comment-mark'

/** Replies and resolves carry this origin, which the editor's undo skips. */
export const THREAD_ORIGIN = 'threads'
/** A new thread's record; undo reverts it together with its anchor mark. */
export const THREAD_CREATE_ORIGIN = 'thread-create'

export type { ThreadMessage, ThreadRecord } from '@/lib/task-discussion'

export interface ThreadSeed {
  id: string
  author: string
  authorUserId?: string
  createdAt: string
  messages: Omit<ThreadMessage, 'id'>[]
}

export interface CommentAnchor {
  id: string
  excerpt: string
}

/* Threads: one Y.Map per thread, keyed by id, in the doc's "threads" field. */

function threadMap(doc: Y.Doc) {
  return doc.getMap<Y.Map<unknown>>(THREADS_FIELD)
}

function createThread(seed: ThreadSeed) {
  const thread = new Y.Map<unknown>()
  thread.set('id', seed.id)
  thread.set('author', seed.author)
  if (seed.authorUserId) thread.set('authorUserId', seed.authorUserId)
  thread.set('createdAt', seed.createdAt)
  thread.set('resolved', false)
  const messages = new Y.Array<ThreadMessage>()
  messages.push(
    seed.messages.map((message, index) => ({
      id: `${seed.id}-${index + 1}`,
      ...message,
    }))
  )
  thread.set('messages', messages)
  return thread
}

/** Writes the seed threads; run once, on the seed document only. */
export function seedThreads(doc: Y.Doc, seeds: ThreadSeed[]) {
  const threads = threadMap(doc)
  for (const seed of seeds) threads.set(seed.id, createThread(seed))
}

/** Adds a thread record; the caller marks its anchor in the same breath. */
export function addThread(doc: Y.Doc, seed: ThreadSeed, origin: unknown) {
  doc.transact(() => threadMap(doc).set(seed.id, createThread(seed)), origin)
}

export function replyToThread(
  doc: Y.Doc,
  id: string,
  message: Omit<ThreadMessage, 'id'> & { id?: string },
  origin: unknown = THREAD_ORIGIN
) {
  const messages = threadMap(doc).get(id)?.get('messages')
  if (!(messages instanceof Y.Array)) return false
  // The writer's client id keeps two replies sent apart (offline) distinct.
  const messageId = message.id ?? `${id}-${doc.clientID}-${messages.length + 1}`
  if (message.id && messages.toArray().some(item => item.id === messageId)) return true
  if (message.replyToMessageId && !messages.toArray().some(item => item.id === message.replyToMessageId)) return false
  doc.transact(() => messages.push([{ ...message, id: messageId }]), origin)
  return true
}

export function setThreadResolved(doc: Y.Doc, id: string, resolved: boolean) {
  const thread = threadMap(doc).get(id)
  if (!thread) return false
  doc.transact(() => thread.set('resolved', resolved), THREAD_ORIGIN)
  return true
}

export type ThreadIndex = Record<string, ThreadRecord>

/** A stable snapshot for useSyncExternalStore: a new object only on change. */
export function createThreadStore(doc: Y.Doc) {
  const map = threadMap(doc)
  const listeners = new Set<() => void>()
  let snapshot = map.toJSON() as ThreadIndex

  function onChange() {
    snapshot = map.toJSON() as ThreadIndex
    listeners.forEach((listener) => listener())
  }

  map.observeDeep(onChange)
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    isOpen: (id: string) => snapshot[id]?.resolved === false,
    destroy: () => map.unobserveDeep(onChange),
  }
}

export type ThreadStore = ReturnType<typeof createThreadStore>
