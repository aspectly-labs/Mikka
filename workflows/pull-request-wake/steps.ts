import type { PullWakeEvent } from '@/lib/github/pull-request-wake'

export async function checkPullRequestWake(event: PullWakeEvent, deliveryKey: string) {
  'use step'
  const { wakePullRequestThreads } = await import('@/lib/github/pull-request-wake')
  return wakePullRequestThreads(event, deliveryKey)
}
checkPullRequestWake.maxRetries = 2
