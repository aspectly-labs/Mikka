import type { EveMessage, EveToolPart } from 'eve/client'
import { eveStreamId } from './stream-id'
import { eveTurnMessageId } from '@/lib/conversation/ids'
/** A tool a live reply is using, as the stream reports it. */
export type CoordinatorLiveTool = { call: string; name: string; state: 'running' | 'done' | 'error'; input?: string; output?: string; quote?: string; at?: number; target?: string; displayName?: string; errorCode?: string; errorDetail?: string }

export type CoordinatorLiveReply = {
  id: string
  /**
   * Its id in the conversation (lib/conversation/ids.ts): `eve:<session>:<turn>` once the turn is known, the id its
   * stored row will carry, so the row stays mounted when it commits; a later segment of a split turn adds `:<n>`.
   */
  key: string
  /** The eve turn it belongs to; its stored row's stream id comes from it (lib/eve/stream-id.ts). */
  turnId?: string
  text: string
  committedThrough?: number
  quiet?: boolean
  /** Tools in the order they were called; each keeps its latest state. */
  tools?: CoordinatorLiveTool[]
  /** How long the model has thought so far (`ms`), since when it is thinking now, and what it has thought (masked, as it streams; only when readable). */
  thinking?: { ms: number; since?: number; text?: string }
}

/** Bounded presentation only. eve owns part ordering, replay and lifecycle. */
function preview(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return (typeof value === 'string' ? value : JSON.stringify(value))?.slice(0, 2_000)
}

function tool(part: EveToolPart, at: number): CoordinatorLiveTool {
  return {
    call: part.callId, name: part.name, displayName: part.label, at,
    state: part.state === 'completed' ? 'done' : ['failed', 'rejected', 'cancelled'].includes(part.state) ? 'error' : 'running',
    ...(part.state === 'streaming' ? {} : { input: preview(part.input), output: preview(part.output), errorCode: part.error?.code }),
  }
}

/** Imported history is rendered by Mikka's historical reader with its task and artifact links. */
export function coordinatorAgentReplies(messages: readonly EveMessage[], persistedStreamIds: readonly string[] = [], sessionId?: string): CoordinatorLiveReply[] {
  const saved = new Set(persistedStreamIds)
  // eve splits a turn where the person wrote mid-turn: each part keeps its place by its index within the turn.
  const segments = new Map<string, number>()
  return messages.flatMap(message => {
    const turnId = message.role === 'assistant' ? message.metadata?.turnId : undefined
    const segment = turnId ? segments.get(turnId) ?? 0 : 0
    if (turnId) segments.set(turnId, segment + 1)
    const key = sessionId && turnId ? eveTurnMessageId(sessionId, turnId, segment) : message.id
    if (message.role !== 'assistant' || message.metadata?.imported || saved.has(message.id) || (sessionId && message.metadata?.turnId && saved.has(eveStreamId(sessionId, message.metadata.turnId)))) return []
    let text = '', reasoning = '', thinking = false
    const tools: CoordinatorLiveTool[] = []
    for (const part of message.parts) {
      if (part.type === 'text') text += part.text
      else if (part.type === 'reasoning') { reasoning += part.text; thinking ||= part.state === 'streaming' }
      else if (part.type === 'tool' && !part.hidden) tools.push(tool(part, text.length))
    }
    if (!text && !reasoning && !tools.length) return []
    return [{ id: message.id, key, ...(message.metadata?.turnId ? { turnId: message.metadata.turnId } : {}), text, tools,
      ...(message.metadata?.status === 'streaming' ? {} : { committedThrough: 0 }),
      ...(reasoning || thinking ? { thinking: { ms: 0, ...(thinking ? { since: 0 } : {}), text: reasoning } } : {}),
    }]
  })
}
