'use client'

import { useRef } from 'react'
import type { ConversationMessage } from './model'

/**
 * One store per conversation (`bot:<id>`, `thread:<rootRunId>`, `group:<id>`), as LobeHub keeps one message map per
 * conversation key: messages by id, in one order, whatever source they came from.
 *
 * - `stored`: what the server returned, in its order. A stored message replaces any message with the same id in place.
 * - `live`: what is still arriving (an eve reply keyed `eve:<session>:<turn>`, the id its stored row will carry).
 * - `optimistic`: what the person sent and the server has not returned yet, already under its final id.
 *
 * Messages not stored yet follow the stored ones in the order this conversation first saw them (an optimistic message
 * by its send time), so a reply never shows above the message it answers, and nothing moves when it is stored.
 */

export type ConversationSources = {
  stored: readonly ConversationMessage[]
  live?: readonly ConversationMessage[]
  optimistic?: readonly ConversationMessage[]
}

/** When each message id was first seen, per conversation; it survives a remount (switching chats and back). */
const firstSeen = new Map<string, Map<string, { at: number; order: number }>>()
let order = 0

function seenAt(key: string, message: ConversationMessage, now: number) {
  let seen = firstSeen.get(key)
  if (!seen) { seen = new Map(); firstSeen.set(key, seen) }
  let at = seen.get(message.id)
  if (!at) {
    // An optimistic message is ordered by its own send time; anything else by when it first showed. Within one
    // millisecond, what showed first stays first.
    at = { at: message.metadata?.delivery && message.metadata.at ? message.metadata.at : now, order: order++ }
    seen.set(message.id, at)
  }
  return at
}

/** The conversation's messages in their one order (pure apart from the first-seen record). */
export function mergeConversation(key: string, { stored, live = [], optimistic = [] }: ConversationSources, now = Date.now()): ConversationMessage[] {
  const ids = new Set<string>()
  const out: ConversationMessage[] = []
  for (const message of stored) {
    if (ids.has(message.id)) continue
    ids.add(message.id)
    seenAt(key, message, now)
    out.push(message)
  }
  const pending: { message: ConversationMessage; at: { at: number; order: number } }[] = []
  for (const message of [...optimistic, ...live]) {
    if (ids.has(message.id)) continue
    ids.add(message.id)
    pending.push({ message, at: seenAt(key, message, now) })
  }
  pending.sort((a, b) => a.at.at - b.at.at || a.at.order - b.at.order)
  for (const { message } of pending) out.push(message)
  return out
}

/** `mergeConversation` for a component; the result keeps its identity while nothing in it changed. */
export function useConversation(key: string, sources: ConversationSources): ConversationMessage[] {
  const held = useRef<ConversationMessage[]>([])
  const next = mergeConversation(key, sources)
  if (next.length !== held.current.length || next.some((message, index) => message !== held.current[index])) held.current = next
  return held.current
}

/** Forget a conversation's first-seen record (a test, or a person signing out). */
export function resetConversation(key?: string) {
  if (key) firstSeen.delete(key)
  else firstSeen.clear()
}
