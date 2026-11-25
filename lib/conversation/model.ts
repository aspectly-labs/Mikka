import type { UIMessage } from 'ai'

/**
 * Mikka's one message model for every chat (the Bot chat, an Agent's thread, a group): the AI SDK's `UIMessage`,
 * with Mikka's own facts as `data-*` parts. The daemon already writes runs as `UIMessageChunk`s
 * (packages/daemon/src/chunks.ts); eve replies and stored rows are mapped into the same shape at the store's edge.
 */

/** A failure that belongs to a message: the one place an error shows (`ThreadEntryPart` `error`). */
export type ConversationError = { text: string; code?: string }

export type ConversationData = {
  /** A run or turn failed here. Composer notices are only for what stops a send before it leaves (offline, no model). */
  error: ConversationError
  /** A run's start-up stage (`data-run-stage`, stored by the daemon). */
  'run-stage': { stage: 'repository' | 'worktree' | 'agent_start'; ms: number; ok: boolean }
  /** A real task attached to a Bot's desktop (`data-computer`). */
  computer: { botId: string; runId: string; task: string }
}

/**
 * Where a part came from: its stable key within the conversation and when it was first stored or seen (ms); for a
 * tool call, how long it ran and whether only the end of its output was kept.
 */
export type ConversationPartMeta = { key: string; at: number; durationMs?: number; outputTruncated?: true }

export type ConversationMetadata = {
  /** When the message was written or first seen, ms. */
  at: number
  /** A person's message: still on its way, stored, or not sent (it keeps its text and shows 重试). */
  delivery?: 'sending' | 'sent' | 'failed'
  /** Why a send failed, in the person's words. */
  deliveryError?: string
  /** A reply still arriving. */
  streaming?: boolean
  /** A reply the person stopped. */
  stopped?: boolean
  /** Who wrote a person's message, where that is not the reader (a thread's other people, a group's members). */
  author?: { id: string; name: string; image?: string | null; mine: boolean }
  /** An Agent run's parts, aligned with `parts` (lib/conversation/fold.ts). */
  parts?: ConversationPartMeta[]
  /** The surface's own record this message was built from (a stored chat row, a live reply, a group message). */
  source?: unknown
}

export type ConversationMessage = UIMessage<ConversationMetadata, ConversationData>
export type ConversationPart = ConversationMessage['parts'][number]

/**
 * One operation per conversation, as LobeHub's operation status: a send is `submitted` until the reply starts,
 * `streaming` while it arrives, `awaiting_input` while it waits for the person, then `completed`, `stopped` or `failed`.
 */
export type OperationStatus = 'idle' | 'submitted' | 'streaming' | 'awaiting_input' | 'completed' | 'stopped' | 'failed'

/** A run's status (agent_runs.status) as the conversation's operation. */
export function runOperation(status: string | null | undefined): OperationStatus {
  switch (status) {
    case 'queued': case 'preparing': return 'submitted'
    case 'running': case 'finishing': return 'streaming'
    case 'waiting_input': case 'paused': return 'awaiting_input'
    case 'succeeded': return 'completed'
    case 'stopped': case 'cancelled': return 'stopped'
    case 'failed': return 'failed'
    default: return 'idle'
  }
}
