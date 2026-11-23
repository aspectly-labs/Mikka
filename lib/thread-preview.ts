import 'server-only'
import { pool } from './db'
import type { RequestWorkspaceUser } from './request-workspace'
import { threadIssueAccess } from './thread-panel'

/**
 * The hover card's light read (#2935): enough to name the task and say where
 * the thread stands, without the conversation. Only fields already served to
 * list surfaces; the route caches the projection for 30 seconds.
 */
export interface ThreadPreview {
  issueId: string
  title: string | null
  issueStatus: string | null
  runId: string
  runStatus: string
  outcome: string | null
  lastReply: string | null
  lastReplyAt: string | null
  updatedAt: string
  /** The agent the newest run names — the hover card's 负责 agent (#2930). */
  agentName: string | null
  /** The task's listed pull request, when it has one. */
  pullRequest: { url: string; state: string; title: string | null } | null
}

export async function readThreadPreview(user: RequestWorkspaceUser, issueId: string): Promise<ThreadPreview | null> {
  if (!(await threadIssueAccess(user, issueId))) return null
  // The caller's own latest run on the task, exactly canReadThread's rule
  // (owner only) applied to a hover read.
  const { rows: [row] } = await pool.query<{
    title: string | null; issueStatus: string | null; runId: string; status: string;
    outcome: string | null; lastReply: string | null; lastReplyAt: Date | null; updatedAt: Date;
    agentName: string | null; pullRequests: { url: string; state: string; title?: string }[] | null
  }>(`SELECT i.title, i.status AS "issueStatus", r.id AS "runId", r.status,
      r.outcome, r."lastReply", r."lastReplyAt", greatest(i."updatedAt", r."updatedAt") AS "updatedAt",
      a.name AS "agentName",
      coalesce(i.content->'attrs'->'mikka', i.content->'attrs'->'orvilo')->'pullRequests' AS "pullRequests"
    FROM issues i JOIN agent_runs r ON r."issueId" = i.id AND r."userId" = $2
    LEFT JOIN agents a ON a.id = r."agentId"
    WHERE i.id = $1
    ORDER BY r."createdAt" DESC LIMIT 1`, [issueId, user.id])
  if (!row) return null
  const pullRequest = row.pullRequests?.find(item => item.state === 'open' || item.state === 'draft') ?? row.pullRequests?.[0] ?? null
  return {
    issueId, title: row.title, issueStatus: row.issueStatus, runId: row.runId,
    runStatus: row.status, outcome: row.outcome, lastReply: row.lastReply,
    lastReplyAt: row.lastReplyAt?.toISOString() ?? null, updatedAt: row.updatedAt.toISOString(),
    agentName: row.agentName, pullRequest: pullRequest ? { url: pullRequest.url, state: pullRequest.state, title: pullRequest.title ?? null } : null,
  }
}
