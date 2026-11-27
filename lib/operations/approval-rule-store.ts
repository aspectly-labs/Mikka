import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { approvalRuleKey, ruleBotId, type ApprovalRuleMatch } from './approval-rules'

type Executor = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>

/** Most remembered approvals one person keeps; past it a new 「始终同意」 approves once and remembers nothing. */
export const MAX_APPROVAL_RULES = 500

export interface ApprovalRuleView {
  id: string
  botId: string
  action: string
  match: ApprovalRuleMatch
  createdAt: string
  lastUsedAt: string | null
}

/**
 * Stores one remembered approval. Callers pass the owner and Bot from the
 * stored card they just claimed for that owner, and a match derived from it
 * (lib/operations/approval-rules.ts); nothing here reads client input. True
 * when the rule exists afterwards.
 */
export async function rememberApproval(executor: Executor, input: { ownerId: string; botId: string | null; match: ApprovalRuleMatch; sourceActionId?: string | null }): Promise<boolean> {
  const botId = ruleBotId(input.botId)
  if (!input.ownerId || !botId) return false
  // The insert is conditional on the cap in one statement; a concurrent second
  // click on the same card hits the unique key and keeps the first row.
  const { rows } = await executor.query<{ id: string }>(`WITH counted AS (SELECT count(*) AS n FROM approval_rules WHERE "ownerId"=$1)
    INSERT INTO approval_rules (id,"ownerId","botId",action,match,"matchKey","sourceActionId")
    SELECT $2,$1,$3,$4,$5,$6,$7 FROM counted WHERE counted.n < $8
    ON CONFLICT ("ownerId","botId","matchKey") DO UPDATE SET "sourceActionId"=COALESCE(approval_rules."sourceActionId",EXCLUDED."sourceActionId")
    RETURNING id`, [input.ownerId, randomUUID(), botId, input.match.action, input.match, approvalRuleKey(input.match), input.sourceActionId ?? null, MAX_APPROVAL_RULES])
  if (rows.length) return true
  // At the cap, an existing identical rule still counts as remembered.
  const existing = await executor.query('SELECT 1 FROM approval_rules WHERE "ownerId"=$1 AND "botId"=$2 AND "matchKey"=$3', [input.ownerId, botId, approvalRuleKey(input.match)])
  return Boolean(existing.rowCount)
}

/**
 * Whether the owner remembered an approval for exactly this match from this
 * Bot. The owner and Bot come from the authenticated run, never from tool
 * input, so one person's rule never answers another person's card and a rule
 * for one Bot (and so one workspace) never answers another's.
 */
export async function hasRememberedApproval(executor: Executor, input: { ownerId: string; botId: string | null; match: ApprovalRuleMatch | null }): Promise<boolean> {
  const botId = ruleBotId(input.botId)
  if (!input.ownerId || !botId || !input.match) return false
  const { rowCount } = await executor.query(`UPDATE approval_rules SET "lastUsedAt"=now() WHERE "ownerId"=$1 AND "botId"=$2 AND "matchKey"=$3 AND action=$4 RETURNING id`,
    [input.ownerId, botId, approvalRuleKey(input.match), input.match.action])
  return Boolean(rowCount)
}

/** The owner's remembered approvals, newest first, for 设置 › 权限. */
export async function listApprovalRules(executor: Executor, ownerId: string): Promise<ApprovalRuleView[]> {
  const { rows } = await executor.query<{ id: string; botId: string; action: string; match: ApprovalRuleMatch; createdAt: Date; lastUsedAt: Date | null }>(
    'SELECT id,"botId",action,match,"createdAt","lastUsedAt" FROM approval_rules WHERE "ownerId"=$1 ORDER BY "createdAt" DESC, id LIMIT $2', [ownerId, MAX_APPROVAL_RULES])
  return rows.map(row => ({ id: row.id, botId: row.botId, action: row.action, match: row.match, createdAt: row.createdAt.toISOString(), lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null }))
}

/** Removes one of the owner's remembered approvals. False when it is not theirs or is already gone. */
export async function revokeApprovalRule(executor: Executor, ownerId: string, id: string): Promise<boolean> {
  const { rowCount } = await executor.query('DELETE FROM approval_rules WHERE id=$1 AND "ownerId"=$2', [id, ownerId])
  return Boolean(rowCount)
}
