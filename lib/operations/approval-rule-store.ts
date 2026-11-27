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
  /** False once the Bot was handed over, paused, re-instructed or redefined: the rule no longer answers anything. */
  active: boolean
}

/**
 * The Bot as the person saw it: its private instructions and the person's
 * active Agent definition version for it (agent_kit_heads; the Coordinator's
 * row is keyed 'coordinator'). Any change makes every rule for it stale.
 * `b` is a bots row; `$owner` the rule owner's parameter.
 */
const fingerprint = (owner: string) => `md5(b.instructions || chr(31) || coalesce((SELECT string_agg(coalesce(h.active_version::text, '-'), ',' ORDER BY h.bot_key)
  FROM agent_kit_heads h WHERE h.owner_id = ${owner} AND (h.bot_id = b.id OR (h.bot_key = 'coordinator' AND EXISTS (SELECT 1 FROM coordinator_bots cb WHERE cb."botId" = b.id)))), ''))`
/** A rule still answers only for the same Bot, unpaused, in the same workspace, with the same owner and fingerprint. */
const bound = (owner: string) => `b.id = r."botId" AND b."archivedAt" IS NULL AND b."workspaceId" = r."workspaceId" AND b."ownerId" IS NOT DISTINCT FROM r."botOwnerId" AND ${fingerprint(owner)} = r."botFingerprint"`

/**
 * Stores one remembered approval. Callers pass the owner and Bot from the
 * stored card they just claimed for that owner, and a match derived from it
 * (lib/operations/approval-rules.ts); nothing here reads client input. The
 * rule is bound to the Bot as it is now. True when the rule exists afterwards.
 */
export async function rememberApproval(executor: Executor, input: { ownerId: string; botId: string | null; match: ApprovalRuleMatch; sourceActionId?: string | null }): Promise<boolean> {
  const botId = ruleBotId(input.botId)
  if (!input.ownerId || !botId) return false
  // The insert is conditional on the cap and on a live Bot in one statement; a
  // second click on the same card refreshes the binding of the one rule.
  const { rows } = await executor.query<{ id: string }>(`WITH counted AS (SELECT count(*) AS n FROM approval_rules WHERE "ownerId"=$1),
      current AS (SELECT b.id, b."workspaceId", b."ownerId", ${fingerprint('$1')} AS fp FROM bots b WHERE b.id=$3 AND b."archivedAt" IS NULL)
    INSERT INTO approval_rules (id,"ownerId","botId",action,match,"matchKey","sourceActionId","workspaceId","botOwnerId","botFingerprint")
    SELECT $2,$1,current.id,$4,$5,$6,$7,current."workspaceId",current."ownerId",current.fp FROM counted, current
    WHERE counted.n < $8 OR EXISTS (SELECT 1 FROM approval_rules WHERE "ownerId"=$1 AND "botId"=$3 AND "matchKey"=$6)
    ON CONFLICT ("ownerId","botId","matchKey") DO UPDATE SET "sourceActionId"=EXCLUDED."sourceActionId", "workspaceId"=EXCLUDED."workspaceId",
      "botOwnerId"=EXCLUDED."botOwnerId", "botFingerprint"=EXCLUDED."botFingerprint", "createdAt"=now()
    RETURNING id`, [input.ownerId, randomUUID(), botId, input.match.action, input.match, approvalRuleKey(input.match), input.sourceActionId ?? null, MAX_APPROVAL_RULES])
  return rows.length > 0
}

/**
 * Whether the owner remembered an approval for exactly this match from this
 * Bot, and the Bot is still the one they answered for. The owner and Bot come
 * from the authenticated run, never from tool input, so one person's rule
 * never answers another person's card and a rule for one Bot (and so one
 * workspace) never answers another's.
 */
export async function hasRememberedApproval(executor: Executor, input: { ownerId: string; botId: string | null; match: ApprovalRuleMatch | null }): Promise<boolean> {
  const botId = ruleBotId(input.botId)
  if (!input.ownerId || !botId || !input.match) return false
  const { rowCount } = await executor.query(`UPDATE approval_rules r SET "lastUsedAt"=now() FROM bots b
    WHERE r."ownerId"=$1 AND r."botId"=$2 AND r."matchKey"=$3 AND r.action=$4 AND ${bound('$1')} RETURNING r.id`,
    [input.ownerId, botId, approvalRuleKey(input.match), input.match.action])
  return Boolean(rowCount)
}

/** The owner's remembered approvals, newest first, for 设置 › 权限. */
export async function listApprovalRules(executor: Executor, ownerId: string): Promise<ApprovalRuleView[]> {
  const { rows } = await executor.query<{ id: string; botId: string; action: string; match: ApprovalRuleMatch; createdAt: Date; lastUsedAt: Date | null; active: boolean }>(
    `SELECT r.id,r."botId",r.action,r.match,r."createdAt",r."lastUsedAt",
      EXISTS (SELECT 1 FROM bots b WHERE ${bound('$1')}) AS active
    FROM approval_rules r WHERE r."ownerId"=$1 ORDER BY r."createdAt" DESC, r.id LIMIT $2`, [ownerId, MAX_APPROVAL_RULES])
  return rows.map(row => ({ id: row.id, botId: row.botId, action: row.action, match: row.match, createdAt: row.createdAt.toISOString(), lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null, active: row.active }))
}

/** Removes one of the owner's remembered approvals. False when it is not theirs or is already gone. */
export async function revokeApprovalRule(executor: Executor, ownerId: string, id: string): Promise<boolean> {
  const { rowCount } = await executor.query('DELETE FROM approval_rules WHERE id=$1 AND "ownerId"=$2', [id, ownerId])
  return Boolean(rowCount)
}
