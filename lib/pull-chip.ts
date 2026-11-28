import type { CitationSource } from './coordinator/citations'
import { githubPullRequestKey, type IssuePullRequest } from './issue-metadata'

/**
 * A PR chip's state in a chat (#2922): GitHub's state as Mikka keeps it on the task (the one status source, #1863), and
 * for an open PR its settled checks. Ready and pending need the checks; an open PR without them has no state colour.
 */
export type PullChipState = 'ready' | 'pending' | 'draft' | 'merged' | 'closed' | 'failed'
export type PullChecks = { failed: number; passed?: number; pending?: number }

/** The issue's mapping (Capy's): ready success, pending warning, draft muted, merged violet, closed or failed destructive. */
export const PULL_CHIP_TONES = {
  ready: 'text-success-foreground',
  pending: 'text-warning-foreground',
  draft: 'text-muted-foreground',
  merged: 'text-github-pr-merged',
  closed: 'text-destructive-foreground',
  failed: 'text-destructive-foreground',
} as const satisfies Record<PullChipState, string>

export function pullChipState(state: IssuePullRequest['state'] | undefined, checks?: PullChecks | null): PullChipState | null {
  if (!state) return null
  if (state !== 'open') return state
  if (!checks) return null
  if (checks.failed > 0) return 'failed'
  if ((checks.pending ?? 0) > 0) return 'pending'
  if ((checks.passed ?? 0) > 0) return 'ready'
  return null
}

type Review = { pr?: { url?: string } | null; checks?: PullChecks | null } | null | undefined

/** The PR's state and checks from the tasks and threads a chat already looked up for its citations; null when none has it. */
export function citedPullRequest(url: string, sources: Readonly<Record<string, CitationSource>>): { state: IssuePullRequest['state']; checks: PullChecks | null } | null {
  const key = githubPullRequestKey(url)
  for (const source of Object.values(sources)) {
    const pull = source.pullRequests?.find(pr => githubPullRequestKey(pr.url) === key)
    if (!pull) continue
    const review: Review = source.kind === 'issue' ? source.review : source.issue?.review
    const checks = review?.pr?.url && githubPullRequestKey(review.pr.url) === key ? review.checks ?? null : null
    return { state: pull.state, checks }
  }
  return null
}
