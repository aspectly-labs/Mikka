import { isUsageTurnRef, type UsageTurnRef } from './usage-turn-ref'

/**
 * The model calls of conversation turns (#2934 item 5), for the line under a reply (#2922). Receipts are read by the
 * turn reference written when each call was made (lib/usage-turn-ref.ts); nothing is matched by time.
 *
 * A reader sees the calls they made or that ran for them ("actorId" or "executionOwnerId"), in their workspace: the
 * same rule for the Bot chat, a group chat and an agent thread. A group turn someone else started shows nothing.
 */
export interface TurnUsage {
  models: string[]
  calls: number
  inputTokens: number
  outputTokens: number
  /**
   * Sum of the priced calls. When `unpricedCalls` > 0 this is only part of the cost: show it as "at least", never as
   * the total. Null when no call is priced (a subscription's provider cost is unknown, not zero).
   */
  costMicroUsd: number | null
  unpricedCalls: number
  /** Who paid; with mixed calls, Mikka 额度 first, then the subscription, then an own API key. */
  source: 'credits' | 'subscription' | 'api_key'
}

export const MAX_TURN_REFS = 200
const SOURCE_ORDER = ['credits', 'subscription', 'api_key'] as const

export async function readTurnUsage(
  q: { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
  input: { readerId: string; workspaceId: string; refs: readonly string[] },
): Promise<Record<UsageTurnRef, TurnUsage>> {
  const refs = [...new Set(input.refs.filter(isUsageTurnRef))].slice(0, MAX_TURN_REFS)
  const result: Record<string, TurnUsage> = {}
  if (!refs.length) return result
  // Failed receipts were released and charged nothing; machine prepayments are not model calls. A call refused
  // before its request started settles at 0 with 0 tokens and is not a call either.
  const { rows } = await q.query(
    `SELECT "usageTurnRef" AS ref,model,"billingSource" AS source,state,"costMicroUsd" AS cost,
        "inputTokens" AS input,"outputTokens" AS output
      FROM hosted_usage
      WHERE "usageTurnRef"=ANY($1::text[]) AND state<>'failed' AND id NOT LIKE 'machine:%'
        AND NOT (state='settled' AND "costMicroUsd"=0 AND "inputTokens"=0 AND "outputTokens"=0)
        AND COALESCE("usageWorkspaceId","workspaceId")=$2::uuid AND $3::text IN ("actorId","executionOwnerId")`,
    [refs, input.workspaceId, input.readerId],
  )
  for (const row of rows) {
    const source = row.source === 'subscription' || row.source === 'api_key' ? row.source : 'credits'
    const cost = row.state === 'settled' && row.cost !== null ? Number(row.cost) : null
    const usage = result[String(row.ref)] ??= { models: [], calls: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: null, unpricedCalls: 0, source }
    const model = String(row.model)
    if (!usage.models.includes(model)) usage.models.push(model)
    usage.calls++
    usage.inputTokens += Number(row.input ?? 0)
    usage.outputTokens += Number(row.output ?? 0)
    if (cost === null) usage.unpricedCalls++
    else usage.costMicroUsd = (usage.costMicroUsd ?? 0) + cost
    if (SOURCE_ORDER.indexOf(source) < SOURCE_ORDER.indexOf(usage.source)) usage.source = source
  }
  return result
}
