'use client'

import { useLayoutEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { createChunkFolder, type ChunkRow } from './fold'
import type { ConversationMessage } from './model'

/**
 * The client's side of the one fold: a thread's held chunks folded by the same `foldChunks` the server reads with.
 * Each conversation keeps one folder, so a live append refolds only the run that grew; a read primes the fold before
 * it is shown (hooks/use-issue-thread-read.ts), so the transcript never paints a frame without it.
 */

const folders = new Map<string, ReturnType<typeof createChunkFolder>>()
const folded = new WeakMap<readonly ChunkRow[], ConversationMessage[]>()

function folder(key: string) {
  let fold = folders.get(key)
  if (!fold) { fold = createChunkFolder(); folders.set(key, fold) }
  return fold
}

/** Fold `chunks` for conversation `key` and keep the result for `useFoldedChunks`. */
export async function primeFold(key: string, chunks: readonly ChunkRow[]) {
  const held = folded.get(chunks)
  if (held) return held
  const messages = await folder(key)(chunks)
  folded.set(chunks, messages)
  return messages
}

/** The folded runs of `chunks`: at once when a read primed them, else before the next paint. */
export function useFoldedChunks(key: string, chunks: readonly ChunkRow[] | undefined): ConversationMessage[] {
  const ready = chunks ? folded.get(chunks) : undefined
  const [late, setLate] = useState<{ chunks: readonly ChunkRow[]; messages: ConversationMessage[] } | null>(null)
  // A read that bypassed the fetcher (a cache restored from disk, a page put above) folds as it commits: the fold runs in
  // microtasks, and its result is committed before the browser paints, so the transcript never shows a frame without it.
  useLayoutEffect(() => {
    if (!chunks || ready) return
    let current = true
    void primeFold(key, chunks).then(messages => { if (current) flushSync(() => setLate({ chunks, messages })) })
    return () => { current = false }
  }, [key, chunks, ready])
  // While a new fold runs, the previous one stays on screen: the transcript never blanks.
  return ready ?? late?.messages ?? []
}
