import { messageReferences, pullRequestShortName, referenceMarkerOf, type MessageReference, type ReferenceType } from '@/lib/composer-references'

/**
 * The chat composer's document (TipTap, components/chat/chat-editor) and the
 * string a draft is stored and sent as. The string is what every reader already
 * takes (lib/composer-references.ts, @mikka/protocol/chat-attachments): a task is
 * `[[issue:<id>]]`, a thread `[[run:<id>]]`, a chat `[[chat:<id>]]`, a pull request
 * its URL, a group's Bot or person `@Name` (lib/group-mentions.ts), a skill
 * `$slug`, a file or folder `@path` (`@path/` for a folder). A collapsed paste is
 * its text; an image is an uploaded chat file, whose marker the file list keeps
 * (hooks/use-chat-composer.ts), so it writes nothing here. Pure: no DOM, no React.
 */

/** A chip the `@`, `/` and `$` menus insert: the official Mention node, with the kind of thing it names. */
export type ChipKind = ReferenceType | 'person' | 'bot' | 'skill'
export type MentionAttrs = { id: string; label: string; kind: ChipKind; mentionSuggestionChar?: string }
export type JSONNode = { type: string; text?: string; attrs?: Record<string, unknown>; content?: JSONNode[] }

/** A paste this long is collapsed into a chip (Claude Code's 「Pasted text」, LobeHub's large-paste file). */
export const LONG_PASTE_CHARS = 1500
export const LONG_PASTE_LINES = 30
export const isLongPaste = (text: string) => text.length > LONG_PASTE_CHARS || text.split('\n').length > LONG_PASTE_LINES

/** What a chip writes into the stored message. */
export function chipText(attrs: MentionAttrs): string {
  switch (attrs.kind) {
    case 'task': case 'thread': case 'chat': case 'pr': return referenceMarkerOf(attrs.kind, attrs.id)
    case 'person': case 'bot': return `@${attrs.label}`
    case 'skill': return `$${attrs.id}`
  }
}

/** A file or folder chip: `@src/app.ts`, `@src/lib/`. */
export const sourceText = (path: string, folder: boolean) => `@${path.replace(/\/+$/, '')}${folder ? '/' : ''}`

function inlineText(node: JSONNode): string {
  switch (node.type) {
    case 'text': return node.text ?? ''
    case 'hardBreak': return '\n'
    case 'mention': return chipText(node.attrs as MentionAttrs)
    case 'sourceFile': return sourceText(String(node.attrs?.path ?? ''), Boolean(node.attrs?.folder))
    case 'pasted': return String(node.attrs?.text ?? '')
    case 'image': return ''
    default: return (node.content ?? []).map(inlineText).join('')
  }
}

/** The stored message for a document: one line per paragraph, each chip as its marker. */
export function docToStored(doc: JSONNode): string {
  return (doc.content ?? []).map(block => (block.content ?? []).map(inlineText).join('')).join('\n')
}

export type HydrateContext = {
  /** A reference's name in the chip; one the composer has not looked up yet gets a short fallback. */
  label?: (reference: MessageReference) => string | undefined
  /** The people and Bots a group chat can name with `@Name`. */
  people?: readonly { id: string; name: string; kind: 'person' | 'bot' }[]
  /** Installed skills, by slug. */
  skills?: readonly { slug: string; name: string }[]
  /** File and folder paths become chips only where the composer can search the run's files. */
  files?: boolean
}

export const fallbackReferenceLabel = (reference: Pick<MessageReference, 'type' | 'id'>) =>
  reference.type === 'pr' ? pullRequestShortName(reference.id) ?? reference.id : reference.id.slice(0, 8)

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** `@path/to/file.ext` or `@path/to/folder/`, after a space or at the start, before a space or the end. */
const SOURCE = /(?<=^|\s)@((?:[\w.-]+\/)+(?:[\w.-]+\.\w+)?|[\w-][\w.-]*\.\w+)(?=\s|$)/gu

type Piece = { from: number; to: number; node: JSONNode }

/** The chips a run of plain text holds: `@Name`, `$skill`, `@path`. */
function textPieces(text: string, context: HydrateContext): Piece[] {
  const pieces: Piece[] = []
  const free = (from: number, to: number) => pieces.every(piece => to <= piece.from || from >= piece.to)
  // Longest names first, so `@Ana Lee` wins over `@Ana`.
  for (const person of [...context.people ?? []].filter(item => item.name).sort((a, b) => b.name.length - a.name.length)) {
    for (const match of text.matchAll(new RegExp(`(?<=^|\\s)@${escape(person.name)}(?=$|[\\s.,;:!?。，；：！？、])`, 'giu'))) {
      const from = match.index, to = from + match[0].length
      if (free(from, to)) pieces.push({ from, to, node: { type: 'mention', attrs: { id: person.id, label: person.name, kind: person.kind, mentionSuggestionChar: '@' } } })
    }
  }
  for (const skill of context.skills ?? []) {
    for (const match of text.matchAll(new RegExp(`(?<=^|\\s)\\$${escape(skill.slug)}(?=$|[\\s.,;:!?。，；：！？、])`, 'gu'))) {
      const from = match.index, to = from + match[0].length
      if (free(from, to)) pieces.push({ from, to, node: { type: 'mention', attrs: { id: skill.slug, label: skill.name, kind: 'skill', mentionSuggestionChar: '$' } } })
    }
  }
  if (context.files) {
    for (const match of text.matchAll(SOURCE)) {
      const from = match.index, to = from + match[0].length
      const folder = match[1].endsWith('/')
      if (free(from, to)) pieces.push({ from, to, node: { type: 'sourceFile', attrs: { path: folder ? match[1].slice(0, -1) : match[1], folder } } })
    }
  }
  return pieces.sort((a, b) => a.from - b.from)
}

function lineContent(line: string, context: HydrateContext): JSONNode[] {
  const pieces: Piece[] = messageReferences(line).map(reference => ({
    from: reference.offset, to: reference.offset + reference.length,
    node: { type: 'mention', attrs: { id: reference.id, label: context.label?.(reference) ?? fallbackReferenceLabel(reference), kind: reference.type, mentionSuggestionChar: '@' } },
  }))
  let last = 0
  const content: JSONNode[] = []
  const text = (from: number, to: number) => {
    let at = from
    for (const piece of textPieces(line.slice(from, to), context)) {
      if (piece.from > 0 && at < from + piece.from) content.push({ type: 'text', text: line.slice(at, from + piece.from) })
      content.push(piece.node)
      at = from + piece.to
    }
    if (at < to) content.push({ type: 'text', text: line.slice(at, to) })
  }
  for (const piece of pieces) {
    if (piece.from > last) text(last, piece.from)
    content.push(piece.node)
    last = piece.to
  }
  if (last < line.length) text(last, line.length)
  return content
}

/** The document for a stored message (a saved draft, a recalled prompt, text put in from elsewhere). */
export function storedToDoc(stored: string, context: HydrateContext = {}): JSONNode {
  return { type: 'doc', content: stored.split('\n').map(line => {
    const content = lineContent(line, context)
    return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
  }) }
}
