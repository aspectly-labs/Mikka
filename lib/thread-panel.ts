import 'server-only'
import { pool } from './db'
import { workspacePool } from './workspace-db'
import { threadPanelStateSchema, type ThreadPanelState } from './thread-panel-schema'

export { threadPanelStateSchema, type ThreadPanelState }

/**
 * The right column's per-thread layout ({tabs, active, open}) lives on the
 * server so a reload or another machine restores it (#2935). One row per
 * person and thread: the state is the viewer's own, so writes only ever touch
 * the caller's row, and reads never leave the caller's scope.
 */

const DEFAULT_STATE: ThreadPanelState = { tabs: [], active: '', open: false }

/** The caller may read or keep panel state for a thread it can read: its own
 * thread (the run's owner) in an issue whose workspace still holds them. */
export async function threadPanelAccess(userId: string, issueId: string): Promise<boolean> {
  const { rows: [issue] } = await pool.query<{ userId: string; workspaceId: string | null }>(
    `SELECT "userId", "workspaceId" FROM issues WHERE id = $1`, [issueId])
  if (!issue) return false
  if (!issue.workspaceId) return issue.userId === userId
  const { rows } = await workspacePool.query<{ userId: string }>(
    `SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId" = $1 AND "userId" = $2 AND status = 'active'`,
    [issue.workspaceId, userId])
  return rows.length === 1
}

export async function readThreadPanelState(userId: string, issueId: string): Promise<ThreadPanelState> {
  const { rows: [row] } = await pool.query<{ tabs: unknown; active: string; open: boolean }>(
    `SELECT tabs, active, open FROM thread_panel_states WHERE "userId" = $1 AND "issueId" = $2`, [userId, issueId])
  if (!row) return DEFAULT_STATE
  const parsed = threadPanelStateSchema.safeParse({ tabs: row.tabs, active: row.active, open: row.open })
  return parsed.success ? parsed.data : DEFAULT_STATE
}

export async function writeThreadPanelState(userId: string, issueId: string, state: ThreadPanelState): Promise<void> {
  await pool.query(
    `INSERT INTO thread_panel_states ("userId", "issueId", tabs, active, open)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT ("userId", "issueId") DO UPDATE SET tabs = $3::jsonb, active = $4, open = $5, "updatedAt" = now()`,
    [userId, issueId, JSON.stringify(state.tabs), state.active, state.open])
}
