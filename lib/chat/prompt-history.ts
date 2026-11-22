/**
 * The person's earlier prompts in one thread or chat, newest last, for Up in an
 * empty composer (Claude Code, Codex, Cursor). Kept beside the drafts
 * (lib/hooks/view-state.tsx: browser storage, cleared on logout).
 */
export const PROMPT_HISTORY_MAX = 50
/** A prompt longer than this is not kept: recall is for re-sending a line, not for storing documents. */
export const PROMPT_HISTORY_ENTRY_MAX = 4000

export function rememberPrompt(history: readonly string[], prompt: string): string[] {
  const text = prompt.trim()
  if (!text || text.length > PROMPT_HISTORY_ENTRY_MAX) return [...history]
  const kept = history.filter(entry => entry !== text)
  return [...kept, text].slice(-PROMPT_HISTORY_MAX)
}

/**
 * Up and Down through the history. `at` is the shown entry's index, or null for the person's own draft.
 * Returns the next index (null back at the draft), or undefined when there is nowhere to go.
 */
export function stepPrompt(history: readonly string[], at: number | null, direction: 'older' | 'newer'): number | null | undefined {
  if (direction === 'older') {
    if (!history.length) return undefined
    if (at === null) return history.length - 1
    return at > 0 ? at - 1 : undefined
  }
  if (at === null) return undefined
  return at < history.length - 1 ? at + 1 : null
}
