import 'server-only'
import { pool } from '../db'
import { listNeedsYou, type NeedsYouItem } from '../needs-you'
import { namedOutsideToken } from '../tokens/scope'

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

export async function readCoordinatorOverview(user: OverviewUser): Promise<CoordinatorOverview> {
  const [needsYou, running, pullRequests] = await Promise.all([
    listNeedsYou(user),
    pool.query<{ runId: string; issueId: string | null; workspaceId: string | null; title: string | null; status: string; updatedAt: Date }>(
      `SELECT r.id AS "runId", r."issueId", r."workspaceId", i.title, r.status, r."updatedAt"
       FROM agent_runs r LEFT JOIN issues i ON i.id = r."issueId"
       WHERE r."userId" = $1 AND r.status IN ('queued', 'running')
       ORDER BY r."updatedAt" DESC LIMIT 20`, [user.id]),
    pool.query<{ issueId: string; workspaceId: string | null; branch: string | null; pullRequest: { url?: string; state?: string } | null; status: string; updatedAt: Date }>(
      `SELECT p."issueId", i."workspaceId", p.branch, p."pullRequest", p.status, p."updatedAt"
       FROM run_publications p LEFT JOIN issues i ON i.id = p."issueId"
       WHERE p."userId" = $1 AND p."pullRequest" IS NOT NULL AND p.status <> 'skipped'
       ORDER BY p."updatedAt" DESC LIMIT 20`, [user.id]),
  ])
  // A workspace-scoped token sees only its own workspace's rows; unlinked
  // rows follow the same personal-workspace rule as every other scoped read.
  const inside = async <T>(rows: T[], workspaceOf: (row: T) => string | null) => {
    const kept: T[] = []
    for (const row of rows) if (!(await namedOutsideToken(user, [workspaceOf(row)]))) kept.push(row)
    return kept
  }
  const [runningRows, publicationRows] = await Promise.all([
    inside(running.rows, row => row.workspaceId),
    inside(pullRequests.rows, row => row.workspaceId),
  ])
  return {
    needsYou,
    running: runningRows.map(row => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
    pullRequests: publicationRows.map(row => ({
      issueId: row.issueId, branch: row.branch,
      url: row.pullRequest?.url ?? null, state: row.pullRequest?.state ?? null,
      status: row.status, updatedAt: row.updatedAt.toISOString(),
    })),
  }
}
