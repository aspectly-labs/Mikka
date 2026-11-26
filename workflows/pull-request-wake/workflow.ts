import { sleep } from 'workflow'
import type { PullWakeEvent } from '@/lib/github/pull-request-wake'
import { checkPullRequestWake } from './steps'

/** GitHub calculates mergeability asynchronously. Persist the delays outside the webhook request. */
export async function wakeConflictingPullRequest(event: PullWakeEvent, deliveryKey: string) {
  'use workflow'
  for (const delay of ['3s', '10s', '30s'] as const) {
    await sleep(delay)
    if (!await checkPullRequestWake(event, deliveryKey)) return
  }
}
