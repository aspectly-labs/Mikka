import { createHash } from 'node:crypto'
import { z } from 'zod'
import { completedCiSuite } from './ci-suite-event'
import { readRuntimeSettings } from '@/lib/settings/runtime'
import { ActionFailureError } from '@/lib/action-error'
import { factoryEventId } from '@/lib/factory/event-id'
import { pool } from '@/lib/db'

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const pullEvent = z.object({
  installation: z.object({ id }), repository: z.object({ id, full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
  action: z.string(), pull_request: z.object({ number: id, state: z.literal('open'), mergeable: z.boolean().nullable().optional(), head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) }).optional() }),
  sender: z.object({ type: z.string() }).optional(),
})
type Preference = 'prWakeOnReview' | 'prWakeOnCiFailure' | 'prWakeOnConflict'
export function pullWakeEvent(event: string, payload: unknown) {
  const suite = completedCiSuite(event, payload)
  if (suite && ['failure', 'timed_out', 'action_required'].includes(suite.conclusion)) {
    return { preference: 'prWakeOnCiFailure' as const, ...suite }
  }
  const parsed = pullEvent.safeParse(payload)
  if (!parsed.success) return null
  const { action, repository, installation, pull_request: pull, sender } = parsed.data
  let preference: Preference
  if (event === 'pull_request_review_comment' && action === 'created' && sender?.type !== 'Bot') preference = 'prWakeOnReview'
  else if (event === 'pull_request' && ['synchronize', 'reopened', 'edited'].includes(action) && pull.mergeable !== true && (pull.mergeable === false || pull.head)) preference = 'prWakeOnConflict'
  else return null
  return { preference, repository: repository.full_name, repositoryId: repository.id, installationId: installation.id, numbers: [pull.number], headSha: pull.head?.sha.toLowerCase(), checkConflict: preference === 'prWakeOnConflict' && pull.mergeable == null }
}

export type PullWakeEvent = NonNullable<ReturnType<typeof pullWakeEvent>>

/** Returns true while at least one authorized PR on this head is still being evaluated by GitHub. */
export async function wakePullRequestThreads(event: PullWakeEvent, deliveryKey: string) {
  const repo = event.repository.toLowerCase()
  const urls = event.numbers.map(number => `https://github.com/${repo}/pull/${number}`)
  const { rows } = await pool.query<{ runId: string; userId: string; workspaceId: string; url: string; head: string | null; locale: string | null }>(`
    SELECT DISTINCT ON (lower(p."pullRequest"->>'url'),r."workspaceId",p."userId") p."runId",p."userId",r."workspaceId",lower(p."pullRequest"->>'url') AS url,p."pullRequest"->>'headSha' AS head,preferences.locale
    FROM run_publications p JOIN agent_runs r ON r.id=p."runId" AND r."userId"=p."userId" AND r."issueId"=p."issueId"
    LEFT JOIN attention_settings preferences ON preferences."userId"=p."userId"
    JOIN issues i ON i.id=p."issueId" AND i."workspaceId"=r."workspaceId" AND i."ownershipState"='bound'
    WHERE p.status='published' AND p."remoteKey"=$1 AND (lower(p."pullRequest"->>'url')=ANY($2::text[])
      OR (cardinality($2::text[])=0 AND p."pullRequest"->>'headSha'=$3 AND starts_with(lower(p."pullRequest"->>'url'),$4)))
      AND r."workspaceId" IS NOT NULL AND r."deletedAt" IS NULL
      AND p."pullRequest"->>'state' IN ('open','draft')
      AND (r."botId" IS NULL OR EXISTS (SELECT 1 FROM bots b WHERE b.id=r."botId" AND b."workspaceId"=r."workspaceId" AND b."ownerId"=p."userId"))
    ORDER BY lower(p."pullRequest"->>'url'),r."workspaceId",p."userId",p."createdAt" DESC,p."runId"`,
  [`v2/github.com/${repo}`, urls, event.headSha ?? null, `https://github.com/${repo}/pull/`])
  let pending = false
  for (const row of rows) {
    const number = Number(row.url.slice(row.url.lastIndexOf('/') + 1))
    const expectedHead = 'heads' in event ? event.heads[number] ?? event.headSha : event.headSha
    if (!Number.isSafeInteger(number) || number <= 0 || (expectedHead && row.head !== expectedHead)) continue
    if (!(await readRuntimeSettings(pool, [event.preference], row))[event.preference].value) continue
    const conflict = 'checkConflict' in event && event.checkConflict && row.head ? { number, head: row.head } : undefined
    const { authorizedPullWake } = await import('./user-access')
    const authorized = await authorizedPullWake(row.userId, repo, event.repositoryId, event.installationId, conflict)
    if (authorized === null) pending = true
    if (!authorized) continue
    // The thread delivery ledger expects a UUID and reuses the receipt on redelivery.
    const hex = createHash('sha256').update(JSON.stringify([deliveryKey, event.preference, row.url, row.workspaceId, row.userId])).digest('hex')
    const requestId = `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
    const { sendThreadMessage } = await import('@/lib/thread-continue')
    const { withTaskWorkspace } = await import('@/lib/task-workspace')
    const messages = row.locale === 'en' ? (await import('@/messages/en.json')).default.PullRequestWake : (await import('@/messages/zh-CN.json')).default.PullRequestWake
    const receiptId = factoryEventId('thread-submission', JSON.stringify([row.userId, requestId]))
    const { rows: [receipt] } = await pool.query<{ anchor: string; text: string }>(`SELECT
      payload#>>'{threadSubmission,requestedRunId}' AS anchor,payload->>'text' AS text FROM coordinator_events
      WHERE id=$1 AND "userId"=$2 AND kind='user_message' AND payload->>'source'='thread_continuation'`, [receiptId, row.userId])
    try {
      const { withWorkspaceFactorJob } = await import('@/lib/enterprise/workspace-factor-job')
      await withWorkspaceFactorJob(row.userId, row.workspaceId, () => withTaskWorkspace(row.userId, row.workspaceId,
        () => sendThreadMessage(row.userId, receipt?.anchor ?? row.runId,
          receipt?.text ?? `${messages[event.preference]} ${row.url}`, { source: 'orchestrator' }, requestId)))
    } catch (error) {
      if (!(error instanceof ActionFailureError && ['threadReplaced', 'runNotFound', 'workspaceAccessDenied'].includes(error.code))) throw error
    }
  }
  return pending
}
