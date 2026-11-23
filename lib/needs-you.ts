import 'server-only'
import { pool } from './db'
import { listPendingActions } from './pending-action-store'
import { namedOutsideToken, pendingActionsOutsideToken } from './tokens/scope'
import { readFactoryFlowStates } from './factory/public-flow'

/**
 * One needs-you projection over the live sources (issue #2935): approvals come
 * from the pending-action cards, questions from the factory flow, limits from
 * quota-paused runs (lib/run-quota.ts).
 * It projects only; no second state is stored or derived.
 */
export interface NeedsYouItem {
  kind: 'approval' | 'question' | 'limit'
  /** The thread (task) it waits on; approvals carry no thread. */
  threadId: string | null
  createdAt: string
  /** The source's own kind: the pending action name, or the factory needsYou kind. */
  detail: string | null
}

interface NeedsYouUser { id: string }

export async function listNeedsYou(user: NeedsYouUser): Promise<NeedsYouItem[]> {
  const items: NeedsYouItem[] = []
  const listed = await listPendingActions(user.id)
  const outside = await pendingActionsOutsideToken(user, listed.map(item => item.id))
  for (const action of listed) {
    if (outside.has(action.id)) continue
    items.push({ kind: 'approval', threadId: null, createdAt: action.createdAt, detail: action.action })
  }
  // Every factory task that can still call the person back — including
  // clarification and specification-review tasks waiting before a candidate.
  // readFactoryFlowStates owns the per-stage rules (questionSince, failed,
  // blocked, clarify/spec/handoff) and drops completed or cancelled work itself.
  const { rows } = await pool.query<{ id: string; issueId: string; workspaceId: string | null; stage: string; status: string }>(
    `SELECT t.id, t."issueId", t."workspaceId", t.stage, t.status FROM factory_tasks t
      WHERE t."userId" = $1 AND t.status NOT IN ('cancelled', 'revoked')`, [user.id])
  const states = await readFactoryFlowStates(pool, rows.map(row => ({ id: row.id, stage: row.stage, status: row.status })) as never)
  for (const row of rows) {
    const state = states.get(row.id)
    if (!state?.needsYou || await namedOutsideToken(user, [row.workspaceId])) continue
    items.push({ kind: 'question', threadId: row.issueId, createdAt: state.needsYou.since, detail: state.needsYou.kind })
  }
  // Limits: threads paused on an exhausted subscription quota (lib/run-quota.ts)
  // wait on the person — retry once the window resets or they switch to credits.
  // A thread is named by its chain's root run, the same id the quota cards use.
  const paused = await pool.query<{ id: string; workspaceId: string | null; updatedAt: Date }>(
    `SELECT DISTINCT root.id::text AS id, p."workspaceId", p."updatedAt" FROM agent_runs p
    JOIN LATERAL (
      WITH RECURSIVE up AS (
        SELECT id,"retryOf","continuesRunId" FROM agent_runs WHERE id=p.id
        UNION ALL
        SELECT r.id,r."retryOf",r."continuesRunId" FROM agent_runs r JOIN up ON up."retryOf"=r.id OR up."continuesRunId"=r.id)
      SELECT id FROM up WHERE "retryOf" IS NULL AND "continuesRunId" IS NULL LIMIT 1) root ON true
    WHERE p."userId" = $1 AND p.status = 'paused' AND p."pauseReason" = 'quota_exhausted'`, [user.id])
  for (const run of paused.rows) {
    if (await namedOutsideToken(user, [run.workspaceId])) continue
    items.push({ kind: 'limit', threadId: run.id, createdAt: run.updatedAt.toISOString(), detail: 'quota_exhausted' })
  }
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
