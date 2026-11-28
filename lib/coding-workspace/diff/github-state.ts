import 'server-only'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { WorkspaceReviewError, type DiffSnapshot } from '@mikka/protocol/coding-workspace-review'
import type { GitHubPullGrant } from './github'

const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
const id = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String), z.string().regex(/^[1-9]\d{0,39}$/)])
const response = z.object({ repository: z.object({ pullRequest: z.object({ number: z.number().int().positive(),
  headRefOid: sha, baseRefOid: sha, state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
  repository: z.object({ fullDatabaseId: id, nameWithOwner: z.string() }),
}) }) })
export const observedPullState = z.strictObject({ repositoryId: id, number: z.number().int().positive(), headSha: sha, baseSha: sha,
  state: z.enum(['open', 'approved', 'changes_requested', 'closed', 'merged']), observedAt: z.iso.datetime() })
export type ObservedPullState = z.infer<typeof observedPullState>
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const checkCounts = z.object({ totalCount: count, checkRunCount: count, statusContextCount: count,
  checkRunCountsByState: z.array(z.object({ count, state: z.enum(['ACTION_REQUIRED', 'CANCELLED', 'COMPLETED', 'FAILURE',
    'IN_PROGRESS', 'NEUTRAL', 'PENDING', 'QUEUED', 'SKIPPED', 'STALE', 'STARTUP_FAILURE', 'SUCCESS', 'TIMED_OUT', 'WAITING']) })).nullable(),
  statusContextCountsByState: z.array(z.object({ count, state: z.enum(['ERROR', 'EXPECTED', 'FAILURE', 'PENDING', 'SUCCESS']) })).nullable(),
})
const summaryResponse = z.object({ repository: z.object({ pullRequest: response.shape.repository.shape.pullRequest.extend({
  changedFiles: count, additions: count, deletions: count, isDraft: z.boolean(), mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({ oid: sha,
    statusCheckRollup: z.object({ contexts: checkCounts }).nullable(),
  }) })).max(1) }),
}) }) })
export type GitHubPullSummary = ObservedPullState & { url: string; files: number; additions: number; deletions: number;
  draft: boolean; mergeable: boolean | null; checks: { total: number; passed: number; failed: number; pending: number; neutral: number;
    sha: string; observedAt: string; fingerprint: string } | null }
export function matchingPullState(raw: unknown, snapshot: DiffSnapshot): ObservedPullState | null {
  const state = observedPullState.safeParse(raw)
  return state.success && state.data.repositoryId === snapshot.sourceAccess?.repositoryId && state.data.number === snapshot.pullRequest?.number
    && state.data.headSha === snapshot.revision.headSha && state.data.baseSha === snapshot.pullRequest?.baseSha ? state.data : null
}
const document = `query WorkspaceReviewState($owner:String!,$name:String!,$number:Int!) {
  repository(owner:$owner,name:$name) { pullRequest(number:$number) {
    number headRefOid baseRefOid state reviewDecision repository { fullDatabaseId nameWithOwner }
  } }
}`
const summaryDocument = `query WorkspaceReviewSummary($owner:String!,$name:String!,$number:Int!) {
  repository(owner:$owner,name:$name) { pullRequest(number:$number) {
    number headRefOid baseRefOid state reviewDecision repository { fullDatabaseId nameWithOwner }
    changedFiles additions deletions isDraft mergeable
    commits(last:1) { nodes { commit { oid statusCheckRollup { contexts(first:1) {
      totalCount checkRunCount statusContextCount
      checkRunCountsByState { count state } statusContextCountsByState { count state }
    } } } } }
  } }
}`

/** A display-only observation of the current PR. It does not capture a diff,
 * mutate a snapshot, or authorize a merge. GitHub aggregates the complete check
 * connection; the one-edge window never truncates these connection counts. */
export async function readGitHubPullSummary(grant: GitHubPullGrant, number: number): Promise<GitHubPullSummary> {
  const [owner, name] = grant.fullName.split('/')
  const parsed = summaryResponse.safeParse(await grant.client.graphql(summaryDocument, { owner, name, number }))
  if (!parsed.success) throw new WorkspaceReviewError('workspace_review_github_unavailable')
  const value = parsed.data.repository.pullRequest, observedAt = new Date().toISOString()
  if (value.number !== number || value.repository.fullDatabaseId !== grant.repositoryId
    || value.repository.nameWithOwner.toLowerCase() !== grant.fullName.toLowerCase())
    throw new WorkspaceReviewError('workspace_review_github_forbidden')
  let checks: GitHubPullSummary['checks'] = null
  const commit = value.commits.nodes[0]?.commit
  if (commit?.oid === value.headRefOid) {
    const counts = { total: 0, passed: 0, failed: 0, pending: 0, neutral: 0 }, contexts = commit.statusCheckRollup?.contexts
    if (contexts) {
      const runs = contexts.checkRunCountsByState ?? [], statuses = contexts.statusContextCountsByState ?? []
      if (new Set(runs.map(item => item.state)).size !== runs.length || new Set(statuses.map(item => item.state)).size !== statuses.length
        || runs.reduce((sum, item) => sum + item.count, 0) !== contexts.checkRunCount
        || statuses.reduce((sum, item) => sum + item.count, 0) !== contexts.statusContextCount
        || contexts.checkRunCount + contexts.statusContextCount !== contexts.totalCount)
        throw new WorkspaceReviewError('workspace_review_github_unavailable')
      for (const item of [...runs, ...statuses]) {
        const bucket = item.state === 'SUCCESS' ? 'passed' : ['NEUTRAL', 'SKIPPED'].includes(item.state) ? 'neutral'
          : ['ACTION_REQUIRED', 'CANCELLED', 'FAILURE', 'ERROR', 'STALE', 'STARTUP_FAILURE', 'TIMED_OUT'].includes(item.state) ? 'failed' : 'pending'
        counts[bucket] += item.count
      }
      counts.total = contexts.totalCount
    }
    checks = { ...counts, sha: value.headRefOid, observedAt,
      fingerprint: createHash('sha256').update(JSON.stringify([grant.repositoryId, value.headRefOid, counts])).digest('hex') }
  }
  return { repositoryId: grant.repositoryId, number, headSha: value.headRefOid, baseSha: value.baseRefOid,
    state: value.state === 'MERGED' ? 'merged' : value.state === 'CLOSED' ? 'closed' : value.reviewDecision === 'APPROVED'
      ? 'approved' : value.reviewDecision === 'CHANGES_REQUESTED' ? 'changes_requested' : 'open', observedAt,
    url: `https://github.com/${grant.fullName}/pull/${number}`, files: value.changedFiles, additions: value.additions, deletions: value.deletions,
    draft: value.isDraft, mergeable: value.mergeable === 'UNKNOWN' ? null : value.mergeable === 'MERGEABLE', checks }
}

/** GitHub's current reviewDecision includes dismissed/superseded reviews.
 * A previously accepted Mikka batch cannot stand in for that observation. */
export async function readGitHubPullState(grant: GitHubPullGrant, snapshot: DiffSnapshot): Promise<ObservedPullState> {
  if (!snapshot.pullRequest || !snapshot.sourceAccess || snapshot.sourceAccess.repositoryId !== grant.repositoryId)
    throw new WorkspaceReviewError('workspace_review_github_forbidden')
  const [owner, name] = grant.fullName.split('/')
  const observedAt = new Date().toISOString()
  const parsed = response.safeParse(await grant.client.graphql(document, { owner, name, number: snapshot.pullRequest.number }))
  if (!parsed.success) throw new WorkspaceReviewError('workspace_review_github_unavailable')
  const value = parsed.data.repository.pullRequest
  if (value.number !== snapshot.pullRequest.number || value.repository.fullDatabaseId !== grant.repositoryId
    || value.repository.nameWithOwner.toLowerCase() !== grant.fullName.toLowerCase())
    throw new WorkspaceReviewError('workspace_review_github_forbidden')
  if (value.headRefOid !== snapshot.revision.headSha || value.baseRefOid !== snapshot.pullRequest.baseSha)
    throw new WorkspaceReviewError('workspace_snapshot_outdated')
  return observedPullState.parse({ repositoryId: grant.repositoryId, number: value.number, headSha: value.headRefOid, baseSha: value.baseRefOid,
    state: value.state === 'MERGED' ? 'merged' : value.state === 'CLOSED' ? 'closed' : value.reviewDecision === 'APPROVED'
      ? 'approved' : value.reviewDecision === 'CHANGES_REQUESTED' ? 'changes_requested' : 'open', observedAt })
}
