import 'server-only'
import { pool } from './db'
import { listPendingActions } from './pending-action-store'
import { namedOutsideToken, pendingActionsOutsideToken } from './tokens/scope'
import { readFactoryFlowStates } from './factory/public-flow'

/**
 * One needs-you projection over the live sources (issue #2935): approvals come
 * from the pending-action cards, questions from the factory flow, limits from
 * the quota pause (source lands with E — the kind stays in the union now).
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
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
