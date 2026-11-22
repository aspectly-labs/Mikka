'use client'

import { useEffect, useRef } from 'react'
import useSWR from 'swr'
import { getThreadMachine, getThreadChanges } from '@/app/actions/agents'
import { listRunArtifacts } from '@/app/actions/artifacts'
import { readThreadSummary } from '@/app/actions/task-runs'

// SWR reads on mount and when the key changes. Only a state change within
// the same mounted run needs an explicit refresh of that run's existing row.
function useStatusRefresh(runId: string | null, issueId: string | null, status: string | undefined, refresh: () => Promise<unknown>) {
  const previous = useRef({ runId, issueId, status })
  useEffect(() => {
    const changed = previous.current.runId === runId && previous.current.issueId === issueId && previous.current.status !== status
    previous.current = { runId, issueId, status }
    if (changed) void refresh()
  }, [runId, issueId, status, refresh])
}

// A reopened row can have changed while unmounted. Share in-flight reads,
// and allow a fresh mount to revalidate a completed read immediately.
export function useRunArtifacts(runId: string, status?: string) {
  const read = useSWR(['run-artifacts', runId], () => listRunArtifacts(runId), { dedupingInterval: 0 })
  useStatusRefresh(runId, null, status, read.mutate)
  return read
}

export function useThreadMachine(issueId: string | null, runId: string, status: string) {
  const read = useSWR(['thread-machine', issueId, runId], () => getThreadMachine(issueId, runId), {
    revalidateOnFocus: false, dedupingInterval: 0,
  })
  useStatusRefresh(runId, issueId, status, read.mutate)
  return read
}

/**
 * The thread's summary (lib/thread-summary.ts): machine size, repository and branch, for the row under the composer.
 * Read once per run state, never on a timer; a reader who does not own the thread reads null.
 */
export function useThreadSummary(runId: string, status: string) {
  const read = useSWR(['thread-summary', runId], async () => {
    const result = await readThreadSummary(runId)
    return result.error ? null : result
  }, { revalidateOnFocus: false, dedupingInterval: 0 })
  useStatusRefresh(runId, null, status, read.mutate)
  return read
}

export function useThreadChanges(issueId: string | null, runId: string | null, status?: string) {
  const read = useSWR(runId ? ['thread-changes', issueId, runId] as const : null,
    ([, issue, run]) => getThreadChanges(issue, run), { dedupingInterval: 0 })
  useStatusRefresh(runId, issueId, status, read.mutate)
  return read
}
