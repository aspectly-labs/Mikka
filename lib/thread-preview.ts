import 'server-only'
import { pool } from './db'
import { threadPanelAccess } from './thread-panel'

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
}

export async function readThreadPreview(userId: string, issueId: string): Promise<ThreadPreview | null> {
  if (!(await threadPanelAccess(userId, issueId))) return null
  // The caller's own latest run on the task, exactly canReadThread's rule
  // (owner only) applied to a hover read.
  const { rows: [row] } = await pool.query<{
    title: string | null; issueStatus: string | null; runId: string; status: string;
    outcome: string | null; lastReply: string | null; lastReplyAt: Date | null; updatedAt: Date
  }>(`SELECT i.title, i.status AS "issueStatus", r.id AS "runId", r.status,
      r.outcome, r."lastReply", r."lastReplyAt", greatest(i."updatedAt", r."updatedAt") AS "updatedAt"
    FROM issues i JOIN agent_runs r ON r."issueId" = i.id AND r."userId" = $2
    WHERE i.id = $1
    ORDER BY r."createdAt" DESC LIMIT 1`, [issueId, userId])
  if (!row) return null
  return {
    issueId, title: row.title, issueStatus: row.issueStatus, runId: row.runId,
    runStatus: row.status, outcome: row.outcome, lastReply: row.lastReply,
    lastReplyAt: row.lastReplyAt?.toISOString() ?? null, updatedAt: row.updatedAt.toISOString(),
  }
}
