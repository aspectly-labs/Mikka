import { CONTEXT_CHARS_SQL, contextUsageFromCounts, type ContextUsage } from './context-usage'

/**
 * What a thread's run holds (lib/context-usage.ts). One query counts every
 * character in SQL and returns no text: a cursor read must stay small, so the
 * brief cannot be sent again to be measured (tests/thread-detail-bytes.db.test.ts).
 * It covers the whole run chain and the whole stored brief whatever the cursor
 * returned, so a cursor read reports the same usage as a full one. The caller
 * has already decided the reader may see these runs.
 */
export async function readContextUsage(
  q: { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
  runIds: readonly string[], rootRunId: string, latestRunId: string,
): Promise<ContextUsage> {
  const { rows: [counted] } = await q.query(CONTEXT_CHARS_SQL, [runIds, rootRunId, latestRunId])
  const count = (value: unknown) => Number(value ?? 0) || 0
  const counts = (ascii: unknown, other: unknown) => ({ ascii: count(ascii), other: count(other) })
  return contextUsageFromCounts({
    prompt: counts(counted?.promptAscii, counted?.promptOther),
    // The task range is sliced in SQL by the recorded code points, and is empty
    // when the range does not hold (lib/thread-prompt.ts rejects it there).
    task: counts(counted?.taskAscii, counted?.taskOther),
    messages: counts(counted?.messageAscii, counted?.messageOther),
    conversation: counts(counted?.conversationAscii, counted?.conversationOther),
    ...(typeof counted?.selectedModel === 'string' || typeof counted?.servedModel === 'string' ? { composerModel: {
      selected: typeof counted?.selectedModel === 'string' ? counted.selectedModel : null,
      served: typeof counted?.servedModel === 'string' ? counted.servedModel : null,
    } } : {}),
    model: typeof counted?.model === 'string' ? counted.model : null,
  })
}
