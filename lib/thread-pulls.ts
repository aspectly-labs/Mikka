import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { mergePullRequest, pullMergeDependencies } from '@/lib/github/pull-merge'

/** A pull request a thread published (run_publications.pullRequest receipt),
 * plus whether the owner armed a "merge when ready" intent on it. */
export type ThreadPullRef = {
  runId: string
  issueId: string
  repo: string
  number: number
  url: string
  title: string | null
  state: 'open' | 'draft' | 'merged' | 'closed'
  headSha: string | null
  autoMerge: boolean
  mergeIntentState: 'armed' | 'cancelled' | 'merged' | 'failed' | null
}

export type ThreadPullMergeResult = {
  repo: string
  number: number
  outcome: 'merged' | 'armed' | 'refused' | 'failed'
  code: string | null
}

const PULL_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/

/** Refusals that end an armed intent for good: the pull itself moved or the
 * person's grant is gone. Mergeability and pending-check codes keep the
 * intent armed — that is what "when ready" means. */
const TERMINAL_REFUSALS = new Set([
  'githubMergeClosed',
  'githubMergeHeadMoved',
  'githubMergeAuthorizationRequired',
])

function repoNumber(url: string): { repo: string; number: number } | null {
  const m = PULL_URL.exec(url)
  return m ? { repo: m[1]!, number: Number(m[2]) } : null
}

/** Pull requests published by any run of a thread's chain, newest chain run
 * first, with the armed merge intent joined on (runId, repo, number). */
export async function listThreadPulls(database: Pick<Pool, 'query'>, ownerId: string, runIds: readonly string[]): Promise<ThreadPullRef[]> {
  if (!runIds.length) return []
  const { rows } = await database.query<{
    runId: string; issueId: string; pullRequest: { url?: unknown; title?: unknown; state?: unknown; headSha?: unknown } | null
    intentState: string | null
  }>(
    `SELECT p."runId",p."issueId",p."pullRequest",i.state AS "intentState"
     FROM run_publications p
     LEFT JOIN thread_pull_merge_intents i ON i."runId"=p."runId" AND i.repo=(regexp_match(p."pullRequest"->>'url','^https://github\\.com/([^/]+/[^/]+)/pull/[0-9]+'))[1]
       AND i.number=(regexp_match(p."pullRequest"->>'url','/pull/([0-9]+)'))[1]::integer AND i."ownerId"=$2
     WHERE p."runId"=ANY($1::uuid[]) AND p."userId"=$2 AND p."pullRequest"->>'url' IS NOT NULL
     ORDER BY p."updatedAt" DESC`,
    [[...runIds], ownerId])
  const pulls: ThreadPullRef[] = []
  for (const row of rows) {
    const url = typeof row.pullRequest?.url === 'string' ? row.pullRequest.url : null
    const key = url ? repoNumber(url) : null
    if (!url || !key) continue
    const raw = row.pullRequest?.state
    pulls.push({
      runId: row.runId, issueId: row.issueId, repo: key.repo, number: key.number, url,
      title: typeof row.pullRequest?.title === 'string' ? row.pullRequest.title : null,
      state: raw === 'merged' || raw === 'closed' || raw === 'draft' ? raw : 'open',
      headSha: typeof row.pullRequest?.headSha === 'string' ? row.pullRequest.headSha : null,
      autoMerge: row.intentState === 'armed',
      mergeIntentState: (row.intentState as ThreadPullRef['mergeIntentState']) ?? null,
    })
  }
  return pulls
}

/** Arm or clear the intent for one pull the thread published. The pull must
 * be a publication receipt of this chain — an intent can never be planted on
 * a pull the thread did not produce. */
export async function setThreadPullMergeIntent(database: Pick<Pool, 'query'>,
  ownerId: string, workspaceId: string | null, taskId: string | null, runId: string,
  input: { repo: string; number: number; headSha: string; enabled: boolean; confirmFailedChecks?: boolean }): Promise<ThreadPullRef['mergeIntentState']> {
  const { rows: [pub] } = await database.query(
    `SELECT 1 FROM run_publications WHERE "runId"=$1 AND "userId"=$2
       AND "pullRequest"->>'url'=$3`, [runId, ownerId, `https://github.com/${input.repo}/pull/${input.number}`])
  if (!pub) return null
  if (input.enabled) {
    await database.query(
      `INSERT INTO thread_pull_merge_intents (id,"ownerId","workspaceId","taskId","runId",repo,number,"headSha","confirmFailedChecks",state,"failCode","mergeCommitSha")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'armed',NULL,NULL)
       ON CONFLICT ("runId",repo,number) DO UPDATE SET "headSha"=$8,"confirmFailedChecks"=$9,state='armed',"failCode"=NULL,"mergeCommitSha"=NULL,"updatedAt"=now()`,
      [randomUUID(), ownerId, workspaceId ?? '00000000-0000-0000-0000-000000000000', taskId, runId, input.repo, input.number, input.headSha, !!input.confirmFailedChecks])
    return 'armed'
  }
  await database.query(
    `UPDATE thread_pull_merge_intents SET state='cancelled',"updatedAt"=now()
      WHERE "runId"=$1 AND "ownerId"=$2 AND repo=$3 AND number=$4 AND state='armed'`,
    [runId, ownerId, input.repo, input.number])
  return 'cancelled'
}

/** Try every armed intent on these runs once. Still-blocked pulls stay armed;
 * merged pulls record their commit; terminal refusals close the intent. The
 * merge runs as the person with their own GitHub token — same gate as the
 * pull directory's merge endpoint. */
export async function drainThreadPullMergeIntents(database: Pick<Pool, 'query'>,
  ownerId: string, runIds: readonly string[], budget = { deadline: Date.now() + 50_000 }): Promise<ThreadPullMergeResult[]> {
  if (!runIds.length) return []
  const { rows } = await database.query<{
    id: string; runId: string; repo: string; number: number; headSha: string; confirmFailedChecks: boolean
  }>(
    `SELECT id,"runId",repo,number,"headSha","confirmFailedChecks" FROM thread_pull_merge_intents
      WHERE "ownerId"=$1 AND "runId"=ANY($2::uuid[]) AND state='armed' ORDER BY "createdAt"`,
    [ownerId, [...runIds]])
  const deps = pullMergeDependencies(budget)
  const results: ThreadPullMergeResult[] = []
  for (const intent of rows) {
    const outcome = await mergePullRequest(ownerId, {
      repo: intent.repo, number: intent.number,
      expectedHeadSha: intent.headSha, confirmFailedChecks: intent.confirmFailedChecks,
    }, deps)
    if (outcome.kind === 'merged') {
      await database.query(
        `UPDATE thread_pull_merge_intents SET state='merged',"mergeCommitSha"=$3,"updatedAt"=now() WHERE id=$1 AND "ownerId"=$2`,
        [intent.id, ownerId, outcome.mergeCommitSha])
      results.push({ repo: intent.repo, number: intent.number, outcome: 'merged', code: outcome.mergeCommitSha })
    } else if (outcome.kind === 'refused' && TERMINAL_REFUSALS.has(outcome.code)) {
      await database.query(
        `UPDATE thread_pull_merge_intents SET state='failed',"failCode"=$3,"updatedAt"=now() WHERE id=$1 AND "ownerId"=$2`,
        [intent.id, ownerId, outcome.code])
      results.push({ repo: intent.repo, number: intent.number, outcome: 'failed', code: outcome.code })
    } else {
      results.push({ repo: intent.repo, number: intent.number, outcome: 'armed', code: outcome.kind === 'refused' ? outcome.code : null })
    }
  }
  return results
}
