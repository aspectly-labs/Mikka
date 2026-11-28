import 'server-only'
import { ActionFailureError } from '@/lib/action-error'
import { queueDelegatedRun } from '@/lib/agent-runs'

/** Worker-visible refusal codes. Expected admission failures map onto this
 * small vocabulary; anything else is a programming error that propagates. */
export function delegationErrorCode(error: ActionFailureError): 'delegated_child_active' | 'delegation_limit' | 'delegation_unavailable' {
  if (error.code === 'runAlreadyActive') return 'delegated_child_active'
  if ((error.params as { reason?: unknown } | undefined)?.reason === 'delegationLimit') return 'delegation_limit'
  return 'delegation_unavailable'
}

/**
 * `delegate_subagent` worker tool: the calling run asks for one bounded
 * sub-agent run on its own task (docs/factory/3089-run-delegation.md, #3089).
 * The authenticated run is the parent — never a tool argument. All scope,
 * credential and live-run checks happen inside `queueDelegatedRun` /
 * `acceptLocalRun`; this helper only validates the worker's two inputs and maps
 * expected refusals onto `delegationErrorCode`. The returned `childRunId` is a
 * queued run id to track with list_runs/get_run, never a claim work finished.
 */
export async function delegateSubagent(run: { id: string; userId: string; issueId: string | null },
  input: { task?: unknown; requestKey?: unknown }) {
  if (typeof input.task !== 'string' || !input.task.trim() || input.task.trim().length > 4000 ||
      typeof input.requestKey !== 'string' || !input.requestKey.trim() || input.requestKey.trim().length > 140) {
    return { error: 'delegation_unavailable' as const }
  }
  if (!run.issueId) return { error: 'delegation_unavailable' as const }
  try {
    const result = await queueDelegatedRun(run.id, run.userId, { task: input.task.trim(), requestKey: input.requestKey.trim() })
    return { childRunId: result.runId, status: result.status ?? 'queued', replayed: result.replayed === true }
  } catch (error) {
    if (!(error instanceof ActionFailureError)) throw error
    return { error: delegationErrorCode(error) }
  }
}
