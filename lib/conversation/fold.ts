import { readUIMessageStream, type UIMessageChunk } from 'ai'
import type { ConversationMessage, ConversationPartMeta } from './model'
import { runScoped, splitRunScoped } from './ids'

/**
 * The one fold from an Agent run's stored chunks to messages, Mikka's version of LobeHub's shared reducer
 * (re-implemented, never copied). The server's history read and the client's live updates call this same function on
 * the same rows, so a thread reads the same on the phone, in the page after a reload and in the page as it streams.
 *
 * The AI SDK's `readUIMessageStream` does the folding. Before it, one pure pass makes stored chunks a valid stream:
 * - every id is scoped to its run (`runScoped`), so a second run never collides with or renames the first;
 * - a delta whose part was never opened (an older daemon, a page boundary) opens it; a result for a call never seen is
 *   dropped; `start`, `finish` and step markers are the fold's own;
 * - an `error` chunk becomes the message's `data-error` part, the one place a failure shows;
 * - each part keeps its key and when it was first stored (`metadata.parts`), which places people's messages between
 *   an Agent's parts (lib/conversation/interleave.ts), and a call's duration and cut output;
 * - a part's chunks are gathered where the part began (a text's deltas, a call's result), which leaves the folded
 *   message unchanged and makes every part whole, so a long run folds in bounded blocks.
 * The SDK snapshots the whole message on every chunk; blocks and passing tool payloads by reference keep that linear.
 */

export type ChunkRow = { chunk: Record<string, unknown>; at: Date | string | number; runId?: string; seq?: number }

/** One part's chunks, gathered where the part was created: every part folds on its own, whatever came in between. */
type Group = { meta: ConversationPartMeta; chunks: UIMessageChunk[] }
type Normalized = { groups: Group[]; payloads: Map<string, unknown>; firstAt: number }

const SKIPPED = new Set(['start', 'finish', 'start-step', 'finish-step', 'abort', 'message-metadata'])
/** Parts folded per pass: the SDK snapshots the whole message on every chunk, so a run folds in bounded blocks. */
const BLOCK = 48

const time = (at: ChunkRow['at']) => typeof at === 'number' ? at : new Date(at).getTime()

/**
 * The run a stored chunk belongs to: the row's own, else the run its id was scoped to. Rows from `chainChunks` carry
 * a scoped id on every chunk (lib/issue-run-conversation.ts), data and error chunks included.
 */
export function chunkRun(row: ChunkRow): string | undefined {
  if (row.runId) return row.runId
  const id = row.chunk.toolCallId ?? row.chunk.id
  return typeof id === 'string' ? splitRunScoped(id)?.runId : undefined
}

/** The message id of a run's output. */
export const runMessageId = (runId: string) => `run:${runId}`

function normalize(runId: string, rows: readonly ChunkRow[]): Normalized {
  const scope = (id: unknown) => runId === '' ? String(id) : runScoped(runId, String(id))
  const groups: Group[] = []
  // Keyed by call and field, so a payload's handle never depends on what came before it (a block folded earlier keeps it).
  const payloads = new Map<string, unknown>()
  const openText = new Map<string, Group>(), openReasoning = new Map<string, Group>()
  const calls = new Map<string, Group>()
  const dataParts = new Map<string, Group>()
  let lastKey = 'start'
  let unnamed = 0
  const ref = (value: unknown, handle: string) => {
    if (value === undefined || value === null || typeof value !== 'object') return value
    payloads.set(handle, value)
    return { $mikkaRef: handle }
  }
  const group = (key: string, at: number, first: UIMessageChunk) => {
    const created: Group = { meta: { key, at }, chunks: [first] }
    groups.push(created)
    lastKey = key
    return created
  }
  for (const { chunk: raw, at: rawAt } of rows) {
    const type = raw.type
    if (typeof type !== 'string' || SKIPPED.has(type) || raw.transient === true) continue
    const at = time(rawAt)
    if (type === 'text-start' || type === 'text-delta' || type === 'text-end' || type === 'reasoning-start' || type === 'reasoning-delta' || type === 'reasoning-end') {
      const kind = type.startsWith('reasoning') ? 'reasoning' : 'text'
      const open = kind === 'reasoning' ? openReasoning : openText
      const id = scope(raw.id ?? `${kind}#${unnamed}`)
      let current = open.get(id)
      if (type.endsWith('-start') || !current) {
        if (type.endsWith('-end') && !current) continue
        current = group(`${kind}:${id}`, at, { type: `${kind}-start`, id } as UIMessageChunk)
        open.set(id, current)
        if (type.endsWith('-start')) continue
      }
      if (type.endsWith('-end')) { open.delete(id); current.chunks.push({ type: `${kind}-end`, id } as UIMessageChunk); continue }
      const delta = typeof raw.delta === 'string' ? raw.delta : ''
      // A part's deltas are one write.
      const previous = current.chunks.at(-1) as { type?: string; delta?: string }
      if (previous.type === `${kind}-delta`) previous.delta += delta
      else current.chunks.push({ type: `${kind}-delta`, id, delta } as UIMessageChunk)
      continue
    }
    if (type === 'tool-input-start' || type === 'tool-input-delta' || type === 'tool-input-available' || type === 'tool-input-error') {
      if (raw.toolCallId === undefined) continue
      const id = scope(raw.toolCallId)
      const toolName = typeof raw.toolName === 'string' && raw.toolName ? raw.toolName : 'tool'
      const chunk: UIMessageChunk | null = type === 'tool-input-delta' ? { type, toolCallId: id, inputTextDelta: typeof raw.inputTextDelta === 'string' ? raw.inputTextDelta : '' }
        : type === 'tool-input-start' ? { type, toolCallId: id, toolName, dynamic: true }
        : type === 'tool-input-available' ? { type, toolCallId: id, toolName, input: ref(raw.input, `${id}:input`), dynamic: true }
        : { type, toolCallId: id, toolName, input: ref(raw.input, `${id}:input`), errorText: typeof raw.errorText === 'string' ? raw.errorText : '', dynamic: true }
      const current = calls.get(id)
      if (current) current.chunks.push(chunk)
      else if (type !== 'tool-input-delta') calls.set(id, group(`tool:${id}`, at, chunk))
      continue
    }
    if (type === 'tool-output-available' || type === 'tool-output-error') {
      if (raw.toolCallId === undefined) continue
      const id = scope(raw.toolCallId)
      const current = calls.get(id)
      if (!current) continue
      if (typeof raw.toolDurationMs === 'number' && Number.isFinite(raw.toolDurationMs) && raw.toolDurationMs >= 0) current.meta.durationMs = raw.toolDurationMs
      if (raw.outputTruncated === true) current.meta.outputTruncated = true
      current.chunks.push(type === 'tool-output-available' ? { type, toolCallId: id, output: ref(raw.output, `${id}:output`), dynamic: true }
        : { type, toolCallId: id, errorText: typeof raw.errorText === 'string' ? raw.errorText : '', dynamic: true })
      continue
    }
    if (type === 'error') {
      const id = raw.id !== undefined ? scope(raw.id) : scope(`error@${lastKey}#${unnamed++}`)
      group(`data:error:${id}`, at, { type: 'data-error', id, data: { text: typeof raw.errorText === 'string' ? raw.errorText : '' } } as UIMessageChunk)
      continue
    }
    if (type.startsWith('data-')) {
      const id = raw.id !== undefined ? scope(raw.id) : scope(`${type}@${lastKey}#${unnamed++}`)
      const key = `data:${type}:${id}`
      const chunk = { type, id, data: raw.data } as UIMessageChunk
      // A data part written again under its id replaces its data in place.
      const current = dataParts.get(key)
      if (current) current.chunks = [chunk]
      else dataParts.set(key, group(key, at, chunk))
      continue
    }
    if (type === 'file' || type === 'source-url' || type === 'source-document') {
      group(`${type}:${scope(raw.sourceId ?? raw.url ?? `#${unnamed++}`)}`, at, raw as UIMessageChunk)
    }
  }
  return { groups, payloads, firstAt: groups[0]?.meta.at ?? (rows[0] ? time(rows[0].at) : 0) }
}

function restore(value: unknown, payloads: Map<string, unknown>): unknown {
  if (value && typeof value === 'object' && '$mikkaRef' in value && typeof value.$mikkaRef === 'string') return payloads.get(value.$mikkaRef)
  return value
}

/** One block of whole parts through the SDK's fold. */
async function foldBlock(messageId: string, groups: readonly Group[]): Promise<ConversationMessage['parts']> {
  const stream = new ReadableStream<UIMessageChunk>({ start(controller) {
    controller.enqueue({ type: 'start', messageId })
    for (const { chunks } of groups) for (const chunk of chunks) controller.enqueue(chunk)
    controller.close()
  } })
  let message: ConversationMessage | null = null
  // A chunk the SDK still refuses leaves the message as folded so far; nothing is thrown at a reader.
  for await (const snapshot of readUIMessageStream<ConversationMessage>({ stream, onError: () => undefined })) message = snapshot
  return message?.parts ?? []
}

/** A block's content in brief: its parts' chunk counts and text lengths, which is all a later chunk can change. */
function signature(groups: readonly Group[]) {
  return groups.map(({ chunks, meta }) => `${meta.key}/${chunks.length}/${(chunks.at(-1) as { delta?: string }).delta?.length ?? ''}`).join('|')
}

type BlockCache = Map<number, { signature: string; parts: Promise<ConversationMessage['parts']> }>

async function foldRun(runId: string, rows: readonly ChunkRow[], cache?: BlockCache): Promise<ConversationMessage> {
  const { groups, payloads, firstAt } = normalize(runId, rows)
  const id = runMessageId(runId)
  const blocks: Promise<ConversationMessage['parts']>[] = []
  for (let start = 0; start < groups.length; start += BLOCK) {
    const slice = groups.slice(start, start + BLOCK)
    // A live run grows at its end: the blocks before it fold once.
    const sig = cache ? signature(slice) : ''
    const held = cache?.get(start)
    if (held && held.signature === sig) { blocks.push(held.parts); continue }
    const parts = foldBlock(id, slice)
    cache?.set(start, { signature: sig, parts })
    blocks.push(parts)
  }
  const parts = (await Promise.all(blocks)).flat().map(part => part.type === 'dynamic-tool' || part.type.startsWith('tool-')
    ? { ...part, ...('input' in part ? { input: restore(part.input, payloads) } : {}), ...('output' in part ? { output: restore(part.output, payloads) } : {}) } as typeof part
    : part)
  return { id, role: 'assistant', parts, metadata: { at: firstAt, parts: groups.slice(0, parts.length).map(group => ({ ...group.meta })) } }
}

/** Rows grouped by run, in the order runs first appear. */
function byRun(rows: readonly ChunkRow[]) {
  const runs = new Map<string, ChunkRow[]>()
  let current = ''
  for (const row of rows) {
    current = chunkRun(row) ?? current
    const list = runs.get(current)
    if (list) list.push(row)
    else runs.set(current, [row])
  }
  return runs
}

/** A thread's stored chunks, across its runs, as one assistant message per run (`run:<runId>`). */
export async function foldChunks(rows: readonly ChunkRow[]): Promise<ConversationMessage[]> {
  return Promise.all([...byRun(rows)].map(([runId, list]) => foldRun(runId, list)))
}

/**
 * `foldChunks` that keeps each run it has folded: a run whose rows are the same rows as last time is not folded again,
 * so a live update refolds only the run that grew. The result equals `foldChunks` on the same rows.
 */
export function createChunkFolder() {
  const held = new Map<string, { first: ChunkRow['chunk']; last: ChunkRow['chunk']; count: number; message: Promise<ConversationMessage> }>()
  const blocks = new Map<string, BlockCache>()
  return (rows: readonly ChunkRow[]): Promise<ConversationMessage[]> => Promise.all([...byRun(rows)].map(([runId, list]) => {
    const previous = held.get(runId)
    if (previous && previous.count === list.length && previous.first === list[0].chunk && previous.last === list.at(-1)!.chunk) return previous.message
    let cache = blocks.get(runId)
    if (!cache) { cache = new Map(); blocks.set(runId, cache) }
    const message = foldRun(runId, list, cache)
    held.set(runId, { first: list[0].chunk, last: list.at(-1)!.chunk, count: list.length, message })
    return message
  }))
}
