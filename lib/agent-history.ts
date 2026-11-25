import { composerDisplay, type MessageReference } from './composer-references'
import { extractLegacyOpenUIText } from './legacy-chat-content'

export type SavedAgentSession = { id: string; title: string; updatedAt: string; preview?: string }

/** Markdown's own punctuation, moved out of the way of the syntax passes and back afterwards (escapes, code, addresses). */
const shield = (text: string) => text.replace(/[!-/:-@[-`{-~]/g, char => String.fromCharCode(0xE000 + char.charCodeAt(0)))
const unshield = (text: string) => text.replace(/[\uE021-\uE07E]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xE000))

/**
 * Chat markdown as one plain line, the way a chat app's list shows the last
 * message: shared by the sidebar's Bot and group rows, the phone's home, and
 * the right column's thread rows. The words stay and the syntax goes: heading,
 * quote, list and task-box markers, rules, table pipes, bold, strikethrough,
 * *italic*, code ticks, HTML tags, link and image targets (a link reads as
 * its text, an image as its alt text), citation tokens ([[issue:…]]). A code
 * fence reads as its first line. Single underscores stay, so
 * MIKKA_R2_ACCESS_KEY reads as written, and an escaped character reads as itself.
 */
export function markdownLine(text: string): string {
  const blocks = /^[ \t]{0,3}(?:#{1,6}[ \t]+|(?:>[ \t]?)+|[-*+][ \t]+|\d+[.)][ \t]+)/gm
  return unshield(text
    .replace(/\\([!-/:-@[-`{-~])/g, (_, char: string) => shield(char))
    // A fence, closed or still streaming, reads as its first line of code.
    .replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n?([\s\S]*?)(?:^[ \t]{0,3}\1[ \t]*$|(?![\s\S]))/gm, (_, __, code: string) => `\n${shield(code.split('\n').find(line => line.trim()) ?? '')}\n`)
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, __, code: string) => shield(code))
    .replace(/<((?:https?|mailto):[^\s<>]+)>/gi, (_, address: string) => shield(address))
    .replace(/<\/?[a-z][^<>\n]*>/gi, ' ')
    .replace(/\[\[(?:issue|run|chat):[^\]\s]+\]\]/gi, '')
    .replace(/!?\[([^\]\n]*)\]\([^)\s]+(?:[ \t]+"[^"\n]*")?\)/g, '$1')
    // Rules, setext underlines and a table's delimiter row are only syntax.
    .replace(/^[ \t]{0,3}(?:([-*_])(?:[ \t]*\1){2,}|=+|\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?)[ \t]*$/gm, '')
    .replace(blocks, '').replace(blocks, '')
    .replace(/^[ \t]*\[[ xX]\][ \t]+/gm, '')
    .replace(/^[ \t]*\|(.*?)\|?[ \t]*$/gm, (_, cells: string) => cells.replace(/\|/g, ' '))
    .replace(/(\*\*|__|~~)(\S(?:[\s\S]*?\S)?)\1/g, '$2')
    .replace(/\*(\S(?:[^*\n]*?\S)?)\*/g, '$1')
    .replace(/`+/g, '')
    .replace(/\s+/g, ' ')
    .trim())
}

/** At most `max` characters (never half of one), ending in an ellipsis when cut. */
function clip(text: string, max = 120): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`
}

/**
 * A sidebar row's last-message line: each typed reference by its name
 * (`label`, as the composer shows it; #2924), then the message as plain text
 * (`chatPreview`). A card that shows no words reads as `card`; no message, as null.
 */
export function chatRowPreview(text: string | null | undefined, label: (reference: MessageReference) => string, card: string): string | null {
  if (!text?.trim()) return null
  return chatPreview(composerDisplay(text, label).text) ?? card
}

/**
 * One line of plain text for the conversation list: the first sentence-sized
 * string in the reply (OpenUI Lang keeps prose in quoted arguments), else
 * plain-text replies as they are, else the person's last message.
 */
export function sessionPreview(completion: string | null | undefined, prompt: string | null | undefined): string {
  const reply = completion?.trim() ?? ''
  for (const match of reply.matchAll(/"((?:[^"\\\n]|\\.){4,})"/g)) {
    try {
      const text = (JSON.parse(`"${match[1]}"`) as string).replace(/\s+/g, ' ').trim()
      if (/[\p{L}\p{N}]/u.test(text) && !/^[\w-]+$/.test(text)) return text.slice(0, 120)
    } catch { /* not a JSON string literal */ }
  }
  if (reply && !/^\w+\s*=/.test(reply)) return reply.replace(/[#*`>_]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)
  return (prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

/**
 * A chat message as the one plain line a bot or group row shows, on the web
 * and on the phone. Markdown reads as its text. Historical OpenUI replies read
 * as the first words they show (their prose, then their cards' text), never
 * their raw source; null when they show no words (charts/forms only), and the
 * row shows its card placeholder instead.
 */
export function chatPreview(text: string): string | null {
  const legacy = extractLegacyOpenUIText(text, { omitCharts: true })
  if (legacy === null) return clip(markdownLine(text))
  for (const line of legacy.split('\n')) {
    const plain = markdownLine(line)
    if (plain) return clip(plain)
  }
  return null
}

export type SavedAgentTurn = { id: string; prompt: string; completion: string; status: 'pending' | 'complete' | 'failed' | 'stopped'; error: string | null }
/** Optional while clients and servers roll forward independently. The current GET
 * returns the selected owner's title even when it is outside the recent list. */
export type AgentHistory = { sessions: SavedAgentSession[]; sessionId: string | null; selectedSession?: { id: string; title: string } | null; turns: SavedAgentTurn[] }
