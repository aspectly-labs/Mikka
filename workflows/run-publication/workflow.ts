import { workflowWakes } from '../wake'
import { wakeTokens } from '@/lib/workflow-wake-tokens'
import { deliverResult, failResult, publishResult } from './steps'

/** The first retry waits as long as it always did; each later one doubles, up to the cap (#1212). */
export const PUBLICATION_RETRY_FIRST_MS = 30_000
export const PUBLICATION_RETRY_MAX_MS = 10 * 60_000

/** Repeats `attempt` until it reports done: 30 s, 1, 2, 4, 8 min, then every 10 min. A
 * GitHub outage or another worker's two-minute lease rarely clears faster than that. */
export async function untilDone(runId: string, attempt: () => Promise<{ done: boolean; retryAt?: number }>, wake = workflowWakes(wakeTokens.runPublication(runId))) {
  for (let wait = PUBLICATION_RETRY_FIRST_MS; ; wait = Math.min(wait * 2, PUBLICATION_RETRY_MAX_MS)) {
    const result = await attempt()
    if (result.done) return
    await wake(Date.now() + Math.max(wait, (result.retryAt ?? 0) - Date.now()))
  }
}

/** GitHub retries and duplicate launch leases survive function restarts. */
export async function runPublication(runId: string) {
  'use workflow'
  const wake = workflowWakes(wakeTokens.runPublication(runId))
  try {
    await untilDone(runId, () => publishResult(runId), wake)
  } catch {
    await untilDone(runId, () => failResult(runId), wake)
  }
  await deliverResult(runId)
}
