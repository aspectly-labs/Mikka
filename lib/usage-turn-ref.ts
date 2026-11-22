/**
 * Which conversation turn a model call served (#2934 item 5): one reference for every chat, written into
 * hosted_usage."usageTurnRef" when the call is made, so a reply's usage is read by id, never matched by time or by
 * how a daemon names its text blocks.
 *
 * - Bot chat: `eve:<session>:<turn>`, the same id the saved reply carries as `mikkaStreamId` (lib/eve/projection.ts).
 * - Group chat: `group:<message>`, the person's message that started the turn; each reply's `replyToId` is that id.
 * - Agent thread: `run:<run>:<turn>` (written by the gateway once the daemon names its turn; #2934 follow-up).
 */
export type UsageTurnRef = `eve:${string}` | `group:${string}` | `run:${string}`

/** Mirrors the column's CHECK constraint (drizzle/20261122084255_hosted_usage_turn_ref.sql). */
const TURN_REF = /^(eve|group|run):[A-Za-z0-9:_.-]+$/

export function isUsageTurnRef(value: unknown): value is UsageTurnRef {
  return typeof value === 'string' && value.length <= 400 && TURN_REF.test(value)
}

/** A reference only when every part is a plain id; otherwise none, so a malformed id never fails the model call. */
function ref(kind: 'eve' | 'group' | 'run', ...parts: string[]): UsageTurnRef | null {
  const value = `${kind}:${parts.join(':')}`
  return parts.every(part => part.length > 0) && isUsageTurnRef(value) ? value : null
}

export const eveTurnRef = (sessionId: string, turnId: string) => ref('eve', sessionId, turnId)
export const groupTurnRef = (messageId: string) => ref('group', messageId)
export const runTurnRef = (runId: string, turnId: string) => ref('run', runId, turnId)
