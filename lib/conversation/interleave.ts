import type { ConversationMessage, ConversationMetadata, ConversationPartMeta } from './model'

/**
 * A thread's one order: what the Agent's runs said (folded per run, lib/conversation/fold.ts) and what people wrote
 * (`run_messages`, outside the chunk log), merged. The rule:
 *
 * - The Agent's parts keep the order the daemon stored them in (run, then seq); they are never re-sorted by time.
 * - A person's message sits before the first Agent part that was first stored strictly after it. A part stored at the
 *   same instant goes first, as the history read orders chunks before messages at an equal time (lane 0 before 1).
 * - People's messages keep their own order (time, then id).
 *
 * Each stretch of Agent parts between two person messages is one assistant message, keyed by its first part's key
 * (a run-scoped chunk id): a later chunk, a later run or a message arriving late never changes an earlier stretch's id.
 */

export type PersonMessage = {
  /** The client-minted submission id when the person sent it from this app, else the stored row's id. */
  id: string
  text: string
  at: number
  author?: ConversationMetadata['author']
  source?: unknown
}

const meta = (message: ConversationMessage, index: number): ConversationPartMeta =>
  message.metadata?.parts?.[index] ?? { key: `${message.id}#${index}`, at: message.metadata?.at ?? 0 }

export function interleave(runs: readonly ConversationMessage[], people: readonly PersonMessage[]): ConversationMessage[] {
  const waiting = [...people].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const out: ConversationMessage[] = []
  let open: { message: ConversationMessage; parts: ConversationPartMeta[] } | null = null
  const say = (person: PersonMessage) => {
    open = null
    out.push({ id: person.id, role: 'user', parts: [{ type: 'text', text: person.text }],
      metadata: { at: person.at, delivery: 'sent', ...(person.author ? { author: person.author } : {}), ...(person.source !== undefined ? { source: person.source } : {}) } })
  }
  for (const run of runs) {
    for (const [index, part] of run.parts.entries()) {
      const where = meta(run, index)
      while (waiting.length && waiting[0].at < where.at) say(waiting.shift()!)
      const current: { message: ConversationMessage; parts: ConversationPartMeta[] } = open ?? (() => {
        const message: ConversationMessage = { id: where.key, role: 'assistant', parts: [], metadata: { at: where.at, parts: [] } }
        out.push(message)
        return { message, parts: message.metadata!.parts! }
      })()
      open = current
      current.message.parts.push(part)
      current.parts.push(where)
    }
  }
  for (const person of waiting) say(person)
  return out
}
