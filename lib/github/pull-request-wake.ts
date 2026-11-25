import { createHash } from 'node:crypto'
import { z } from 'zod'
import { completedCiSuite } from './ci-suite-event'
import { readRuntimeSettings } from '@/lib/settings/runtime'
import { sendThreadMessage } from '@/lib/thread-continue'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { pool } from '@/lib/db'

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const pullEvent = z.object({
  installation: z.object({ id }), repository: z.object({ id, full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
  action: z.string(), pull_request: z.object({ number: id, state: z.literal('open'), mergeable: z.boolean().nullable().optional() }),
  sender: z.object({ type: z.string() }).optional(),
})
type Preference = 'prWakeOnReview' | 'prWakeOnCiFailure' | 'prWakeOnConflict'
const messages: Record<Preference, string> = {
  prWakeOnReview: 'A reviewer commented on this pull request.',
  prWakeOnCiFailure: 'A CI check failed on this pull request.',
  prWakeOnConflict: 'This pull request has a merge conflict.',
}

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
  else if (event === 'pull_request' && ['synchronize', 'reopened', 'edited'].includes(action) && pull.mergeable === false) preference = 'prWakeOnConflict'
  else return null
  return { preference, repository: repository.full_name, repositoryId: repository.id, installationId: installation.id, numbers: [pull.number] }
}

export async function wakePullRequestThreads(event: NonNullable<ReturnType<typeof pullWakeEvent>>, deliveryKey: string) {
  const repo = event.repository.toLowerCase()
  const urls = event.numbers.map(number => `https://github.com/${repo}/pull/${number}`)
  if (!urls.length) return
  const { rows } = await pool.query<{ runId: string; userId: string; workspaceId: string; url: string; head: string | null }>(`
    SELECT DISTINCT ON (lower(p."pullRequest"->>'url'),r."workspaceId",p."userId") p."runId",p."userId",r."workspaceId",lower(p."pullRequest"->>'url') AS url,p."pullRequest"->>'headSha' AS head
    FROM run_publications p JOIN agent_runs r ON r.id=p."runId" AND r."userId"=p."userId" AND r."issueId"=p."issueId"
    JOIN issues i ON i.id=p."issueId" AND i."workspaceId"=r."workspaceId" AND i."ownershipState"='bound'
    JOIN github_repository_installations g ON g."userId"=p."userId" AND g."remoteKey"=p."remoteKey"
    WHERE p.status='published' AND p."remoteKey"=$1 AND lower(p."pullRequest"->>'url')=ANY($2::text[])
      AND g."installationId"=$3 AND g."repositoryId"=$4 AND r."workspaceId" IS NOT NULL AND r."deletedAt" IS NULL
      AND p."pullRequest"->>'state' IN ('open','draft')
      AND (r."botId" IS NULL OR EXISTS (SELECT 1 FROM bots b WHERE b.id=r."botId" AND b."workspaceId"=r."workspaceId" AND b."ownerId"=p."userId"))
    ORDER BY lower(p."pullRequest"->>'url'),r."workspaceId",p."userId",p."createdAt" DESC,p."runId"`,
  [`v2/github.com/${repo}`, urls, event.installationId, event.repositoryId])
  for (const row of rows) {
    if ('heads' in event) {
      const number = row.url.slice(row.url.lastIndexOf('/') + 1)
      if (row.head !== (event.heads[number] ?? event.headSha)) continue
    }
    if (!(await readRuntimeSettings(pool, [event.preference], row))[event.preference].value) continue
    // The thread delivery ledger expects a UUID and reuses the receipt on redelivery.
    const hex = createHash('sha256').update(JSON.stringify([deliveryKey, event.preference, row.runId])).digest('hex')
    const requestId = `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
    await withTaskWorkspace(row.userId, row.workspaceId, () =>
      sendThreadMessage(row.userId, row.runId, `${messages[event.preference]} ${row.url}`, { source: 'orchestrator' }, requestId))
  }
}
