import { splitCitations } from './coordinator/citation-parts'

/**
 * Typed references in a message (#2924, #2941). The stored form is the message
 * text itself: a task is `[[issue:<id>]]`, a thread `[[run:<id>]]`, an
 * independent chat `[[chat:<id>]]`, a pull request its GitHub URL. The same
 * markers already carry the Coordinator's citations and the thread mentions
 * (lib/thread-references.ts), so every reader of a message sees one syntax.
 * `messageReferences` derives the issue's `references: [{type, id, offset}]`
 * from that text; nothing stores a second copy that could drift from it.
 */
export type ReferenceType = 'task' | 'thread' | 'chat' | 'pr'
export type MessageReference = { type: ReferenceType; id: string; offset: number; length: number }

const PULL_REQUEST = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/

/** Every typed reference in a stored message, in order, with its place in the text. */
export function messageReferences(text: string): MessageReference[] {
  const references: MessageReference[] = []
  let offset = 0
  for (const part of splitCitations(text, true)) {
    if (part.type === 'text') { offset += part.text.length; continue }
    if (part.type === 'chat' || part.type === 'bot') {
      if (part.type === 'bot') { offset += 8 + part.id.length; continue }
      // `[[chat:` + id + `]]`, as the pattern matched it.
      const length = 9 + part.id.length
      references.push({ type: 'chat', id: part.id, offset, length })
      offset += length
      continue
    }
    if (part.type === 'citation' && 'raw' in part && part.kind) references.push({ type: part.kind === 'issue' ? 'task' : 'thread', id: part.id, offset, length: part.raw.length })
    else if (part.type === 'link' && part.label === null && PULL_REQUEST.test(part.url)) references.push({ type: 'pr', id: part.url, offset, length: part.raw.length })
    if ('raw' in part) offset += part.raw.length
  }
  return references
}

/** The stored marker for a reference. */
export function referenceMarkerOf(type: ReferenceType, id: string): string {
  if (type === 'pr') return id
  return `[[${type === 'task' ? 'issue' : type === 'thread' ? 'run' : 'chat'}:${id}]]`
}

export const referenceKey = (reference: { type: ReferenceType; id: string }) => `${reference.type}:${reference.id}`

/** `repo#12` for a pull request URL. */
export function pullRequestShortName(url: string): string | null {
  const match = /^https:\/\/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url)
  return match ? `${match[1]}#${match[2]}` : null
}

/** A reference as the composer shows it: its name in the text, one piece. */
export type ComposerToken = { from: number; to: number; reference: MessageReference; label: string }
export type ComposerDisplay = { text: string; tokens: ComposerToken[] }

/**
 * The draft as the textarea shows it: each reference by its name (no `@`, as
 * Capy), never its marker. `label` names a reference the composer has not
 * looked up yet, such as one in a saved draft.
 */
export function composerDisplay(stored: string, label: (reference: MessageReference) => string): ComposerDisplay {
  const tokens: ComposerToken[] = []
  let text = '', last = 0
  for (const reference of messageReferences(stored)) {
    text += stored.slice(last, reference.offset)
    // A name never holds a line break: one reference is one piece of one line.
    const name = label(reference).replace(/\s+/g, ' ').trim() || reference.id
    tokens.push({ from: text.length, to: text.length + name.length, reference, label: name })
    text += name
    last = reference.offset + reference.length
  }
  return { text: text + stored.slice(last), tokens }
}

/** Where a place in the shown text falls in the stored text; a place inside a reference moves to its edge. */
function storedAt(stored: string, display: ComposerDisplay, at: number, side: 'start' | 'end'): number {
  let shift = 0
  for (const token of display.tokens) {
    if (at <= token.from) break
    if (at < token.to) return side === 'start' ? token.reference.offset : token.reference.offset + token.reference.length
    shift = token.reference.offset + token.reference.length - token.to
  }
  return Math.min(stored.length, at + shift)
}

/**
 * The stored draft after the person edits the shown text. A reference is one
 * piece: an edit that touches any part of its name removes all of it, and the
 * typed text takes its place. `caret` (the field's caret after the edit) picks
 * the edited place when the same letters repeat around it.
 */
export function editComposerDisplay(stored: string, display: ComposerDisplay, next: string, caret?: number): string {
  const before = display.text
  if (next === before) return stored
  let prefix = 0
  const limit = Math.min(before.length, next.length)
  let suffix = 0
  if (caret !== undefined && caret >= 0 && caret <= next.length) {
    const tail = next.length - caret
    if (tail <= before.length && before.endsWith(next.slice(caret))) suffix = tail
  } else {
    while (suffix < limit && before[before.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
  }
  const prefixLimit = Math.min(before.length - suffix, next.length - suffix)
  while (prefix < prefixLimit && before[prefix] === next[prefix]) prefix++
  let start = prefix, end = before.length - suffix
  const inserted = next.slice(prefix, next.length - suffix)
  for (const token of display.tokens) {
    const touched = start === end ? token.from < start && start < token.to : token.from < end && token.to > start
    if (!touched) continue
    start = Math.min(start, token.from)
    end = Math.max(end, token.to)
  }
  return stored.slice(0, storedAt(stored, display, start, 'start')) + inserted + stored.slice(storedAt(stored, display, end, 'end'))
}

/** Replaces the shown range [from, to) (plain text, such as `@task:check`) with a reference and a space after it. */
export function insertComposerReference(stored: string, display: ComposerDisplay, from: number, to: number, marker: string): string {
  const start = storedAt(stored, display, from, 'start'), end = storedAt(stored, display, to, 'end')
  const after = stored.slice(end)
  return stored.slice(0, start) + marker + (after.startsWith(' ') ? '' : ' ') + after
}

/** The reference whose name ends (Backspace) or starts (Delete) at the caret, to select before it is removed. */
export function tokenAtCaret(display: ComposerDisplay, caret: number, key: 'Backspace' | 'Delete'): ComposerToken | null {
  return display.tokens.find(token => key === 'Backspace' ? token.to === caret : token.from === caret) ?? null
}

/** The `/command` being typed: the whole draft is one slash word. */
export function slashCommandAt(text: string, caret: number): { query: string } | null {
  const match = /^\/([\w-]{0,32})$/.exec(text.slice(0, caret))
  return match && !/\S/.test(text.slice(caret)) ? { query: match[1].toLowerCase() } : null
}
