/**
 * Which conversation turn a model call served (#2934 item 5): one reference for every chat, written into
 * hosted_usage."usageTurnRef" when the call is made, so a reply's usage is read by id, never matched by time or by
 * how a daemon names its text blocks.
 *
 * - Bot chat: `eve:<session>:<turn>`, the same id the saved reply carries as `mikkaStreamId` (lib/eve/projection.ts).
 * - Group chat: a reply is `group:<message>:<reply>`, from the published reply's `replyToId` and its own id (chosen
 *   before its generation); routing and corrections the whole turn shares are `group:<message>`. A generation that
 *   published nothing (silent, stopped) stays on its own reference and is not shown under any reply.
 * - Agent thread: `run:<run>:<turn>` (written by the gateway once the daemon names its turn; #2934 follow-up).
 *
 * Written today only for calls paid from Mikka 额度 through hosted_usage reserve. Not yet: a Bot or group Bot on the
 * person's subscription or own API key, an agent thread, a delegated Eve session (recorded under its own session) and
 * Decisions in tool steps. A turn with no entry has unknown usage, never zero.
 */
export type UsageTurnRef = `eve:${string}` | `group:${string}` | `run:${string}`

/** The longest reference the column's CHECK constraint accepts. */
export const MAX_TURN_REF_LENGTH = 400
/** Mirrors the column's CHECK constraint (drizzle/20261122084255_hosted_usage_turn_ref.sql). */
const TURN_REF = /^(eve|group|run):[A-Za-z0-9:_.-]+$/

export function isUsageTurnRef(value: unknown): value is UsageTurnRef {
  return typeof value === 'string' && value.length <= MAX_TURN_REF_LENGTH && TURN_REF.test(value)
}

/** A reference only when every part is a plain id; otherwise none, so a malformed id never fails the model call. */
function ref(kind: 'eve' | 'group' | 'run', ...parts: string[]): UsageTurnRef | null {
  const value = `${kind}:${parts.join(':')}`
  return parts.every(part => part.length > 0) && isUsageTurnRef(value) ? value : null
}

export const eveTurnRef = (sessionId: string, turnId: string) => ref('eve', sessionId, turnId)
export const groupTurnRef = (messageId: string, replyId?: string) =>
  replyId ? ref('group', messageId, replyId) : ref('group', messageId)
export const runTurnRef = (runId: string, turnId: string) => ref('run', runId, turnId)
