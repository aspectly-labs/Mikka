import 'server-only'
import { pool } from './db'
import { workspacePool } from './workspace-db'
import { readRunChain } from './run-chain'
import type { RequestWorkspaceUser } from './request-workspace'
import { namedOutsideToken } from './tokens/scope'
import { threadPanelStateSchema, type ThreadPanelState } from './thread-panel-schema'

export { threadPanelStateSchema, type ThreadPanelState }

/**
 * The right column's per-thread layout ({tabs, active, open}) lives on the
 * server so a reload or another machine restores it (#2935). One row per
 * person and thread — the thread's identity is its chain's root run, not the
 * task, so two threads on one task keep their own layouts. The state is the
 * viewer's own: writes only ever touch the caller's row, and reads never
 * leave the caller's scope (a workspace-scoped token included).
 */

const DEFAULT_STATE: ThreadPanelState = { tabs: [], active: '', open: false }

interface PanelUser extends RequestWorkspaceUser {}

/** The caller may read a thread's surface on this task: its own thread in an
 * issue whose workspace still holds them — and, for a workspace-scoped token,
 * whose workspace is the token's. */
export async function threadIssueAccess(user: PanelUser, issueId: string): Promise<boolean> {
  const { rows: [issue] } = await pool.query<{ userId: string; workspaceId: string | null }>(
    `SELECT "userId", "workspaceId" FROM issues WHERE id = $1`, [issueId])
  if (!issue || await namedOutsideToken(user, [issue.workspaceId])) return false
  if (!issue.workspaceId) return issue.userId === user.id
  const { rows } = await workspacePool.query<{ userId: string }>(
    `SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId" = $1 AND "userId" = $2 AND status = 'active'`,
    [issue.workspaceId, user.id])
  return rows.length === 1
}

/** Same access plus the thread binding: the named run must belong to the
 * task. Returns the chain's root run id — the key every state row lives
 * under — or null. */
export async function threadPanelAccess(user: PanelUser, issueId: string, runId: string): Promise<string | null> {
  const { rows: [run] } = await pool.query<{ issueId: string | null; userId: string }>(
    `SELECT "issueId", "userId" FROM agent_runs WHERE id = $1`, [runId])
  if (!run || run.issueId !== issueId || !(await threadIssueAccess(user, issueId))) return null
  const chain = await readRunChain(pool, run.userId, runId)
  return chain?.rootRunId ?? runId
}

export async function readThreadPanelState(userId: string, rootRunId: string): Promise<ThreadPanelState> {
  const { rows: [row] } = await pool.query<{ tabs: unknown; active: string; open: boolean }>(
    `SELECT tabs, active, open FROM thread_panel_states WHERE "userId" = $1 AND "runId" = $2`, [userId, rootRunId])
  if (!row) return DEFAULT_STATE
  const parsed = threadPanelStateSchema.safeParse({ tabs: row.tabs, active: row.active, open: row.open })
  return parsed.success ? parsed.data : DEFAULT_STATE
}

export async function writeThreadPanelState(userId: string, rootRunId: string, state: ThreadPanelState): Promise<void> {
  await pool.query(
    `INSERT INTO thread_panel_states ("userId", "runId", tabs, active, open)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT ("userId", "runId") DO UPDATE SET tabs = $3::jsonb, active = $4, open = $5, "updatedAt" = now()`,
    [userId, rootRunId, JSON.stringify(state.tabs), state.active, state.open])
}
