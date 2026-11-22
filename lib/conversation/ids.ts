import { eveStreamId } from '@/lib/eve/stream-id'

/**
 * One message id from the moment it shows (LobeHub's client-minted ids, re-implemented): nothing is re-keyed when an
 * optimistic message is stored, when a streamed reply commits, or when a thread runs a second time.
 *
 * - A person's message: the id the client mints when it sends (`newMessageId`); the stored row carries it as its
 *   submission id, so the stored row and the unsent bubble are the same message.
 * - An Agent run's parts: every chunk id is prefixed with its run (`runScoped`), from the first run on, so a second
 *   run never renames the first one's ids. Stored chunks without the prefix get it when they are read.
 * - A Bot's live reply: the stored row's stream id, `eve:<session>:<turn>` (`eveTurnMessageId`), as soon as the turn
 *   id is known; a turn that eve splits because the person wrote mid-turn adds the segment index, `…:<n>`.
 */

const RUN_PREFIX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(.+)$/i

/** A fresh message id for something the person sends. */
export function newMessageId() {
  return crypto.randomUUID()
}

/** `id` within its run: `<runId>:<id>`. Idempotent, so an id already scoped (a later read, a live row) stays as it is. */
export function runScoped(runId: string, id: string | number) {
  const value = String(id)
  return value.startsWith(`${runId}:`) ? value : `${runId}:${value}`
}

/** The run a scoped id belongs to and the id the run gave it; null for an id no run scoped. */
export function splitRunScoped(id: string): { runId: string; local: string } | null {
  const match = RUN_PREFIX.exec(id)
  return match ? { runId: match[1], local: match[2] } : null
}

/** A Bot's reply to one eve turn: the stored row's stream id; a later segment of a split turn adds its index. */
export function eveTurnMessageId(sessionId: string, turnId: string, segment = 0) {
  const id = eveStreamId(sessionId, turnId)
  return segment > 0 ? `${id}:${segment}` : id
}

/**
 * A stored chat row's id (the Bot chat's `coordinator_messages`): the person's message by the submission id the client
 * minted for it (its unsent bubble's id), a reply by its stream id (its live reply's id), else its position.
 */
export function storedChatMessageId(item: { from: string; position: number; pending?: boolean; streamId?: string; submissionId?: string }) {
  if (item.from === 'person' && item.submissionId) return item.submissionId
  return item.pending ? `pending-${item.position}` : item.streamId ?? String(item.position)
}
