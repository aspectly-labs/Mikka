import 'server-only'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { issues, runPublications } from '@/lib/db/schema'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { reviewCheckDetails, type ReviewCheckState } from '@/lib/github/review-checks'

/**
 * The run-worker's own delivery status, read from the server's publication
 * record (`run_publications`) and the task's synchronized pull request links.
 * The persisted rows are the only authority: the daemon never reports branch,
 * pull request or check values it received from the agent, and an absent row
 * reports `null`, never a fabricated or "passing" value.
 */

const githubPullNumber = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/([1-9]\d*)\/?$/

export interface RunPrStatusPullRequest {
  url: string
  number: number | null
  state: 'open' | 'draft' | 'merged' | 'closed'
  branch: string | null
  headSha: string | null
  title: string | null
  author: string | null
  createdAt: string | null
}

export interface RunPrStatus {
  issueId: string | null
  /** The server-assigned issue branch this run delivers to; null until issued. */
  branch: string | null
  baseBranch: string | null
  identifier: string | null
  /** The publication pipeline state for this run's delivery, or absent when the run has none. */
  publication: { status: string; errorCode: string | null } | null
  /** The pull request bound to this run's own publication receipt, if any. */
  pullRequest: RunPrStatusPullRequest | null
  /** Latest synchronized check rollup for the bound PR head; null while unknown. */
  checks: {
    headSha: string
    complete: boolean
    updatedAt: string
    counts: Record<ReviewCheckState, number> | null
    entries: { name: string; state: ReviewCheckState; at: string }[]
  } | null
  /** Pull requests the task already records, whatever run opened them (max 10). */
  taskPullRequests: { url: string; number: number | null; state: string; title: string | null }[]
}

/** Pure projection; tested without a database. Stored rows are read defensively:
 * a missing or malformed field degrades to null, never to an invented value. */
export function projectRunPrStatus(input: {
  issueId: string | null
  publication?: {
    branch: string | null; baseBranch: string | null; identifier: string | null
    status: string; errorCode: string | null
    pullRequest: {
      url?: unknown; state?: unknown; branch?: unknown; headSha?: unknown; title?: unknown; author?: unknown; createdAt?: unknown; reviewChecks?: unknown
    } | null
  } | null
  taskPullRequests?: { url?: unknown; state?: unknown; title?: unknown }[] | null
}): RunPrStatus {
  const stored = input.publication ?? null
  const pr = stored?.pullRequest ?? null
  const url = typeof pr?.url === 'string' ? pr.url : null
  const headSha = typeof pr?.headSha === 'string' && /^[a-f0-9]{40,64}$/i.test(pr.headSha) ? pr.headSha.toLowerCase() : null
  const pullRequest: RunPrStatusPullRequest | null = url ? {
    url,
    number: (() => { const match = githubPullNumber.exec(url); return match ? Number(match[1]) : null })(),
    state: pr?.state === 'draft' || pr?.state === 'merged' || pr?.state === 'closed' ? pr.state : 'open',
    branch: typeof pr?.branch === 'string' ? pr.branch : null,
    headSha,
    title: typeof pr?.title === 'string' ? pr.title.slice(0, 256) : null,
    author: typeof pr?.author === 'string' ? pr.author.slice(0, 200) : null,
    createdAt: typeof pr?.createdAt === 'string' ? pr.createdAt : null,
  } : null
  return {
    issueId: input.issueId,
    branch: stored?.branch ?? null,
    baseBranch: stored?.baseBranch ?? null,
    identifier: stored?.identifier ?? null,
    publication: stored ? { status: stored.status, errorCode: stored.errorCode } : null,
    pullRequest,
    checks: pullRequest && headSha ? reviewCheckDetails(pr?.reviewChecks, headSha) : null,
    taskPullRequests: (input.taskPullRequests ?? []).flatMap(entry => {
      const entryUrl = typeof entry?.url === 'string' ? entry.url : null
      if (!entryUrl) return []
      const match = githubPullNumber.exec(entryUrl)
      return [{
        url: entryUrl, number: match ? Number(match[1]) : null,
        state: typeof entry.state === 'string' ? entry.state : 'open',
        title: typeof entry.title === 'string' ? entry.title.slice(0, 256) : null,
      }]
    }).slice(0, 10),
  }
}

/** The calling run's own publication row plus the task's PR links; the run token
 * already proved live-run, workspace and issue access in `verifyRunToken`. */
export async function runPrStatus(run: { id: string; userId: string; issueId: string | null }): Promise<RunPrStatus> {
  const [publication] = await db.select({
    branch: runPublications.branch, baseBranch: runPublications.baseBranch, identifier: runPublications.identifier,
    status: runPublications.status, errorCode: runPublications.errorCode, pullRequest: runPublications.pullRequest,
  }).from(runPublications).where(and(eq(runPublications.runId, run.id), eq(runPublications.userId, run.userId))).limit(1)
  const [task] = run.issueId
    ? await db.select({ content: issueAttrsContent }).from(issues).where(eq(issues.id, run.issueId)).limit(1)
    : []
  return projectRunPrStatus({
    issueId: run.issueId,
    publication: publication ?? null,
    taskPullRequests: task ? readIssueMetadata(task.content).pullRequests : [],
  })
}
