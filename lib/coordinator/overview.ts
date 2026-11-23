import 'server-only'
import { pool } from '../db'
import { listNeedsYou, type NeedsYouItem } from '../needs-you'
import { tokenScopeFilter } from '../tokens/scope'

/**
 * The Coordinator's cross-thread overview (#2935): every open needs-you item,
 * the work still in flight, and the pull requests the person's runs published.
 * Projection only — the sources (runs, publications, pending actions, factory
 * flow) stay the single state.
 */
export interface CoordinatorOverview {
  needsYou: NeedsYouItem[]
  running: { runId: string; issueId: string | null; title: string | null; status: string; updatedAt: string }[]
  pullRequests: { issueId: string; branch: string | null; url: string | null; state: string | null; status: string; updatedAt: string }[]
}

interface OverviewUser { id: string }

export async function readCoordinatorOverview(user: OverviewUser, workspaceId?: string): Promise<CoordinatorOverview> {
  // The token's workspace filters inside the queries, before the row cap:
  // twenty newer foreign rows must not starve a scoped caller's own work.
  // A caller naming a workspace narrows further — it can never widen the token.
  const [runScope, publicationScope] = await Promise.all([
    tokenScopeFilter(user, 'r."workspaceId"', 2),
    tokenScopeFilter(user, 'i."workspaceId"', 2),
  ])
  const namedRun = workspaceId ? ` AND r."workspaceId" = $${2 + runScope.params.length}` : ''
  const namedPublication = workspaceId ? ` AND i."workspaceId" = $${2 + publicationScope.params.length}` : ''
  const namedParams = workspaceId ? [workspaceId] : []
  const [needsYou, running, pullRequests] = await Promise.all([
    listNeedsYou(user),
    pool.query<{ runId: string; issueId: string | null; title: string | null; status: string; updatedAt: Date }>(
      `SELECT r.id AS "runId", r."issueId", i.title, r.status, r."updatedAt"
       FROM agent_runs r LEFT JOIN issues i ON i.id = r."issueId"
       WHERE r."userId" = $1 AND r.status IN ('queued', 'running')${runScope.sql}${namedRun}
       ORDER BY r."updatedAt" DESC LIMIT 20`, [user.id, ...runScope.params, ...namedParams]),
    pool.query<{ issueId: string; branch: string | null; pullRequest: { url?: string; state?: string } | null; status: string; updatedAt: Date }>(
      `SELECT p."issueId", p.branch, p."pullRequest", p.status, p."updatedAt"
       FROM run_publications p LEFT JOIN issues i ON i.id = p."issueId"
       WHERE p."userId" = $1 AND p."pullRequest" IS NOT NULL AND p.status <> 'skipped'${publicationScope.sql}${namedPublication}
       ORDER BY p."updatedAt" DESC LIMIT 20`, [user.id, ...publicationScope.params, ...namedParams]),
  ])
  return {
    needsYou,
    running: running.rows.map(row => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
    pullRequests: pullRequests.rows.map(row => ({
      issueId: row.issueId, branch: row.branch,
      url: row.pullRequest?.url ?? null, state: row.pullRequest?.state ?? null,
      status: row.status, updatedAt: row.updatedAt.toISOString(),
    })),
  }
}
