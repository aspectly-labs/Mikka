import type { RunChunk } from './chunks'

// #2937: the coarse tool family a reader renders without parsing names —
// shells, readers, searchers and editors each get their own group.
const TOOL_KINDS = new Map<string, string>([
  ['bash', 'shell'], ['shell', 'shell'], ['execute', 'shell'],
  ['read', 'read'], ['view', 'read'], ['cat', 'read'], ['read_file', 'read'],
  ['grep', 'search'], ['glob', 'search'], ['search', 'search'], ['find', 'search'], ['websearch', 'search'], ['web_search', 'search'],
  ['edit', 'edit'], ['write', 'edit'], ['apply_patch', 'edit'], ['str_replace', 'edit'], ['multiedit', 'edit'], ['notebookedit', 'edit'],
])
export const toolKind = (name: string | undefined) => TOOL_KINDS.get(String(name ?? '').toLowerCase()) ?? 'other'

/** Per-session monotonic timings, before outbox batching/retries. Missing starts stay unknown.
 * Also stamps the structured fields (#2937): `toolKind` on input chunks, `toolName`+`toolKind` on outputs. */
export function toolDuration(clock: () => number = () => performance.now()) {
  const starts = new Map<string, { at: number; name?: string }>()
  return (chunk: RunChunk): RunChunk => {
    if (chunk.type === 'tool-input-available') {
      if (!starts.has(chunk.toolCallId)) starts.set(chunk.toolCallId, { at: clock(), name: chunk.toolName })
      const rest = { ...(chunk as Record<string, unknown>) }
      delete rest.toolKind
      return { ...rest, toolKind: toolKind(chunk.toolName) } as RunChunk
    } else if (chunk.type === 'tool-output-available' || chunk.type === 'tool-output-error') {
      const started = starts.get(chunk.toolCallId)
      starts.delete(chunk.toolCallId)
      // Discard adapter-supplied timing; only the start observed in this session counts.
      const result = { ...(chunk as Record<string, unknown>) }
      delete result.toolDurationMs; delete result.toolName; delete result.toolKind
      const elapsed = started === undefined ? undefined : clock() - started.at
      return {
        ...result,
        ...(started?.name ? { toolName: started.name, toolKind: toolKind(started.name) } : {}),
        ...(elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0 ? { toolDurationMs: Math.round(elapsed) } : {}),
      } as RunChunk
    }
    return chunk
  }
}
