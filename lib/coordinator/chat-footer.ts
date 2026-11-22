import { failure, turns, type SessionView } from 'eve/events'
import { eveStreamId } from '@/lib/eve/stream-id'
import type { CoordinatorLiveReply } from '@/lib/eve/chat-view'
import type { BotModelMenu } from '@/lib/bot-model-menu-view'

/**
 * The chat's footer and row identity (UX audit 2026-11-22, issues 1 and 5): one blocking notice above the composer,
 * chosen by priority, and keys that survive a message's commit so no row remounts.
 */

/** The blocking notices above the composer, highest first; only the first that applies shows. */
export const BLOCKING_NOTICES = ['load', 'failure', 'quotaStopped', 'model', 'quota', 'unanswered'] as const
export type BlockingNotice = typeof BLOCKING_NOTICES[number]

export function blockingNotice(applies: Partial<Record<BlockingNotice, boolean>>): BlockingNotice | null {
  return BLOCKING_NOTICES.find(kind => applies[kind]) ?? null
}

/**
 * The stream failed to load (to connect, catch up or resume), as opposed to a turn that ran and failed: that one is
 * the chat's own failure line, read from the stored chat. Eve reports both in `error`; a recorded failure of the
 * latest turn or of the session is the turn's, and a send the chat already marked failed shows on its own bubble.
 */
export function streamLoadFailed(error: Error | undefined, view: SessionView | undefined, sendFailed = false) {
  if (!error || sendFailed) return false
  if (!view) return true
  return failure(view, turns(view).at(-1)?.turnId) === undefined
}

/** Nothing can answer: no model chosen and none to choose, or the chosen Mikka 额度 is unavailable. Send waits. */
export function modelBlocked(menu: BotModelMenu | undefined) {
  const current = menu?.current
  return current?.kind === 'none' || (current?.kind === 'hosted' && !current.available)
}

type KeyedItem = { from: string; position: number; pending?: boolean; streamId?: string; submissionId?: string }

/**
 * A stored row's key: the person's message by the submission id it was sent with (the same id its unsent bubble
 * had), a reply by its stream id (the id its live reply had), else its position.
 */
export function chatItemKey(item: KeyedItem) {
  if (item.from === 'person' && item.submissionId) return item.submissionId
  return item.pending ? `pending-${item.position}` : item.streamId ?? String(item.position)
}

/**
 * A live reply's key: the stream id its stored row will carry (`eve:<session>:<turn>`, lib/eve/projection.ts), so
 * the row keeps its key when the reply commits. A turn's later messages, which commit into the same row, keep their
 * own ids.
 */
export function liveReplyKeys(replies: readonly CoordinatorLiveReply[], sessionId: string | undefined) {
  const taken = new Set<string>()
  return replies.map(reply => {
    const streamId = sessionId && reply.turnId ? eveStreamId(sessionId, reply.turnId) : undefined
    if (!streamId || taken.has(streamId)) return reply.id
    taken.add(streamId)
    return streamId
  })
}
