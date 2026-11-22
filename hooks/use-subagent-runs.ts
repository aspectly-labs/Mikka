'use client'

import { useMemo } from 'react'
import useSWR, { unstable_serialize } from 'swr'
import { readSubagentRuns } from '@/app/actions/task-runs'
import type { RunSource } from '@/lib/coordinator/citations'
import type { SubagentRun } from '@/lib/subagent-runs'
import { useLiveKey } from './use-live-key'

export const subagentRunsKey = (runId: string) => ['subagent-runs', runId] as const

/** A child run as the thread's `task` part reads it: the card's facts, no task (the card shows the run's own state). */
export function subagentRunSource(child: SubagentRun): RunSource {
  return {
    kind: 'run', id: child.id, agentName: '', harness: child.harness, status: child.status, outcome: child.outcome,
    stopReason: child.stopReason, issue: null, title: child.title, name: child.title ?? '', summary: null, steps: 0,
    createdAt: child.createdAt, finishedAt: null, subagent: child.subagent,
  }
}

/**
 * The sub-agents a run dispatched (readSubagentRuns, #2939), oldest first; none until a read succeeds. A refusal (not
 * the run's owner) draws nothing. A child's change wakes this run's `run` live key, so the cards follow without a timer.
 */
export function useSubagentRuns(runId: string | null, workspaceId?: string | null): SubagentRun[] {
  const key = runId ? subagentRunsKey(runId) : null
  const { data } = useSWR(key, () => readSubagentRuns(runId!), { revalidateOnFocus: false, shouldRetryOnError: false })
  useLiveKey('run', runId, key ? [unstable_serialize(key)] : [], workspaceId)
  return useMemo(() => Array.isArray(data) ? data : [], [data])
}
