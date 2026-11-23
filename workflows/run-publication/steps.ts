import { RetryableError } from 'workflow'

export async function publishResult(runId: string) {
  'use step'
  const { publishRunResult } = await import('@/lib/run-publications')
  try {
    return await publishRunResult(runId)
  } catch {
    // Raw database/transport errors must not persist in Workflow or expose credentials;
    // an interrupted worker retains the DB lease for two minutes.
    // error-cause: the raw transport error is dropped so it cannot persist or leak
    throw new RetryableError('Run publication is temporarily unavailable.', { retryAfter: '2m' })
  }
}
publishResult.maxRetries = 8

export async function failResult(runId: string) {
  'use step'
  const { failRunPublication } = await import('@/lib/run-publications')
  return failRunPublication(runId)
}
failResult.maxRetries = 8

export async function deliverResult(runId: string) {
  'use step'
  const { publicationDelivery } = await import('@/lib/run-publications')
  const row = await publicationDelivery(runId)
  if (!row) return
  const { processLinearIssueOutbox } = await import('@/lib/linear-sync/worker')
  const { wakeCoordinator } = await import('@/lib/coordinator/wake')
  await processLinearIssueOutbox(row.issueId)
  await wakeCoordinator(row.userId)
}
