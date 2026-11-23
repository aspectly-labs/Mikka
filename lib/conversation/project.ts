import type { ThreadEntry, ThreadEntryPart } from '@/components/slots/thread-contract'
import type { ConversationMessage, ConversationPart } from './model'

/**
 * The one projection from the conversation's messages to the thread screen's entries (components/slots/thread-contract.ts).
 * It decides what every chat shares: an entry's id (the message's), its side, its time, a person message's delivery
 * state, whether a reply is still arriving or was stopped, and that a failure is the reply's own `error` part. The
 * surface supplies how its words and tools look (`render`); the paid thread screen only ever gets data.
 */

export type ProjectRender = {
  /** A run of text parts as the surface renders words (Markdown, citations). */
  text: (text: string, message: ConversationMessage) => ThreadEntryPart | null
  /** Consecutive tool parts as one tools row; `id` is the first call's. */
  tools?: (id: string, parts: ConversationPart[], message: ConversationMessage) => ThreadEntryPart | null
  /** Any other part (a data part the surface knows). */
  data?: (part: ConversationPart, message: ConversationMessage) => ThreadEntryPart | null
  /** The surface's finishing touches: actions, author, cards, its own failure actions. */
  decorate?: (entry: ThreadEntry, message: ConversationMessage) => ThreadEntry | ThreadEntry[] | null
}

const isTool = (part: ConversationPart) => part.type === 'dynamic-tool' || part.type.startsWith('tool-')

/** A reply's parts top to bottom: words, tool rows, and its failure last, where the reader looks for what happened. */
export function projectParts(message: ConversationMessage, render: ProjectRender): ThreadEntryPart[] {
  const parts: ThreadEntryPart[] = []
  const errors: ThreadEntryPart[] = []
  let text = ''
  let tools: ConversationPart[] = []
  const flushText = () => { if (text.trim()) { const part = render.text(text, message); if (part) parts.push(part) } text = '' }
  const flushTools = () => {
    if (tools.length && render.tools) {
      const first = tools[0] as { toolCallId?: string }
      const part = render.tools(first.toolCallId ?? `${message.id}:tools`, tools, message)
      if (part) parts.push(part)
    }
    tools = []
  }
  for (const part of message.parts) {
    if (part.type === 'text') { flushTools(); text += part.text; continue }
    if (isTool(part)) { flushText(); tools.push(part); continue }
    if (part.type === 'reasoning' || part.type === 'step-start') continue
    flushText(); flushTools()
    if (part.type === 'data-error') { errors.push({ kind: 'error', text: part.data.text }); continue }
    const custom = render.data?.(part, message)
    if (custom) parts.push(custom)
  }
  flushText(); flushTools()
  return [...parts, ...errors]
}

export function projectEntries(messages: readonly ConversationMessage[], render: ProjectRender): ThreadEntry[] {
  const entries: ThreadEntry[] = []
  for (const message of messages) {
    const meta = message.metadata
    const at = meta?.at ?? 0
    let entry: ThreadEntry
    if (message.role === 'user') {
      const text = message.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
      entry = { id: message.id, role: 'person', at, text, status: meta?.delivery ?? 'sent', ...(meta?.deliveryError ? { deliveryMessage: meta.deliveryError } : {}) }
    } else {
      entry = { id: message.id, role: 'bot', at, parts: projectParts(message, render), ...(meta?.streaming ? { streaming: true } : {}), ...(meta?.stopped ? { stopped: true } : {}) }
    }
    const decorated = render.decorate ? render.decorate(entry, message) : entry
    if (decorated) entries.push(...(Array.isArray(decorated) ? decorated : [decorated]))
  }
  return entries
}
