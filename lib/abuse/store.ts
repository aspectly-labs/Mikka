import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { isUsageTurnRef } from '../usage-turn-ref'
import { hostedBillingScope } from './context'
import { resourceBudgetAdmission } from '../billing/resource-budgets'
import { connectForCommitEffects } from '../db/commit-effects'
import { jsonbSafeBigIntExprSql } from '../primitives/jsonb-predicates'
import {
  abuseLimits,
  HOSTED_CALL_HOLD_MICRO_USD,
  HOSTED_MAX_IN_FLIGHT_PER_WORKSPACE,
  MICRO_USD_PER_POINT,
  PaidResourceError,
} from './policy'
import { runtimeEnv, type EnvMap } from '@/lib/env/server'

const expiredMachineHold = `state='unknown' AND COALESCE("machineCompute"->>'source'='cloudflare_cgroup_list',false)
  AND "createdAt" < now() - interval '24 hours'`
const abandonedHold = `"settledAt" IS NULL AND (("createdAt" < now() - interval '10 minutes'
  AND (state='pending' OR (state='unknown' AND "generationId" IS NULL))) OR (${expiredMachineHold}))`
const releaseMachineHold = `"machineCompute"="machineCompute"||'{"outcome":"measurement_expired"}'::jsonb,
  "machineComputeReviewAt"=NULL`
type Query = Pick<PoolClient, 'query'>

function reduceBucketAllocations(
  allocations: Record<string, number>,
  newBucketTotal: number,
  orderedGrantIds: string[],
) {
  let allocatedTotal = 0
  for (const amount of Object.values(allocations)) allocatedTotal += Number(amount)
  let toRemove = Math.max(0, allocatedTotal - newBucketTotal)
  if (toRemove <= 0) return
  const order = [...orderedGrantIds]
  const seen = new Set(order)
  for (const grantId of Object.keys(allocations).reverse()) {
    if (!seen.has(grantId)) order.push(grantId)
  }
  for (const grantId of order) {
    const current = Number(allocations[grantId] ?? 0)
    if (current <= 0) continue
    const cut = Math.min(current, toRemove)
    const next = current - cut
    if (next > 0) allocations[grantId] = next
    else delete allocations[grantId]
    toRemove -= cut
    if (toRemove === 0) break
  }
}
export type HostedQuotaLease = { limit: number; close(): Promise<void>;
  billingAccount?: { workspaceId: string; organizationId: string | null } }
export class HostedUsageStore {
  readonly metered: boolean
  private readonly quota?: (workspaceId: string) => Promise<HostedQuotaLease>
  private readonly workspaceDatabase: Pick<Pool, 'query'>
  constructor(readonly pool: Pool, options: {
    metered?: boolean
    quota?: (workspaceId: string) => Promise<HostedQuotaLease>
    /** Workspace identity lives in WS DB; APP-only deployments must supply it. */
    workspaceDatabase?: Pick<Pool, 'query'>
  } = {}) {
    this.metered = options.metered ?? true
    this.quota = options.quota
    this.workspaceDatabase = options.workspaceDatabase ?? pool
  }
  private async transaction<T>(work: (tx: PoolClient) => Promise<T>) {
    const tx = await connectForCommitEffects(this.pool)
    try {
      await tx.query('BEGIN')
      const result = await work(tx)
      await tx.query('COMMIT')
      return result
    } catch (error) {
      await tx.query('ROLLBACK')
      throw error
    } finally {
      tx.release()
    }
  }
  private async lock(tx: Query, workspaceId: string) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `hosted:${workspaceId}`,
    ])
  }
  /**
   * Fail reservations that can no longer settle, so a stuck row never keeps its
   * hold and concurrency slot forever. A real call settles within
   * HOSTED_CALL_TIMEOUT_MS (60s); the 10-minute margin is far wider so a live
   * stream is never cut. A pending row past it crashed before settling; an
   * unknown row with no generationId can never be reconciled (the cost lookup
   * needs the id). Any reserved free allowance is refunded; no money was charged.
   * The caller already holds the workspace lock.
   */
  private async releaseAbandoned(tx: Query, workspaceId: string) {
    const reaped = await tx.query<{ reservedFree: string }>(
      `UPDATE hosted_usage SET state='failed',"settledAt"=now(),
        "machineCompute"=CASE WHEN ${expiredMachineHold} THEN "machineCompute"||'{"outcome":"measurement_expired"}'::jsonb ELSE "machineCompute" END,
        "machineComputeReviewAt"=CASE WHEN ${expiredMachineHold} THEN NULL ELSE "machineComputeReviewAt" END
       WHERE "workspaceId"=$1 AND (${abandonedHold})
       RETURNING "reservedFree"`,
      [workspaceId],
    )
    const refund = reaped.rows.reduce((sum, row) => sum + Number(row.reservedFree), 0)
    if (refund > 0)
      await tx.query(
        'UPDATE hosted_allowances SET remaining=remaining+$2 WHERE "workspaceId"=$1',
        [workspaceId, refund],
      )
  }
  async verify(
    workspaceId: string,
    customerId: string | null,
    fingerprint: string | null,
    last4: string | null = null,
  ) {
    if (!this.metered) return false
    return this.transaction(async (tx) => {
      await this.lock(tx, workspaceId)
      const verified = await tx.query(
        'INSERT INTO hosted_verifications ("workspaceId","customerId",fingerprint,last4) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING "workspaceId"',
        [workspaceId, customerId, fingerprint, last4],
      )
      if (!verified.rowCount) {
        if (fingerprint) {
          const filled = await tx.query('UPDATE hosted_verifications SET "customerId"=$2,fingerprint=$3,last4=$4 WHERE "workspaceId"=$1 AND (fingerprint IS NULL OR (fingerprint=$3 AND last4 IS NULL AND $4::text IS NOT NULL)) RETURNING "workspaceId"', [workspaceId, customerId, fingerprint, last4])
          if (filled.rowCount) {
            await tx.query('INSERT INTO hosted_card_claims (fingerprint,"workspaceId") VALUES ($1,$2) ON CONFLICT DO NOTHING', [fingerprint, workspaceId])
            // The card's last four digits now show (#1212: the page waiting on the webhook reads on this key).
            await (await import('../live/billing')).hostedBillingChanged(tx, workspaceId)
          }
        }
        return false
      }
      // Verified (and perhaps the allowance granted): the page waiting on the webhook reads again (#1212).
      await (await import('../live/billing')).hostedBillingChanged(tx, workspaceId)
      const first =
        !fingerprint ||
        Boolean(
          (
            await tx.query(
              'INSERT INTO hosted_card_claims (fingerprint,"workspaceId") VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING fingerprint',
              [fingerprint, workspaceId],
            )
          ).rowCount,
        )
      // No free allowance for new verifications (decision 2026-11-15-1900: no trial).
      // Allowances granted before stay usable through balance().
      await tx.query(
        `INSERT INTO workspace_audit_events (id,"workspaceId","actorType","actorName",action,category,metadata) VALUES ($1,$2,'system','Stripe','billing.card_verified','billing',$3)`,
        [
          randomUUID(),
          workspaceId,
          JSON.stringify({ allowanceGranted: false }),
        ],
      )
      return first
    })
  }
  async balance(workspaceId: string, tx: Query = this.pool, at = new Date()) {
    if (!this.metered) return { verified: true, free: 0, plan: 0, purchased: 0 }
    // Already-incurred debt offsets unused free credit as well. Clamping each
    // bucket independently must not turn an overdraft into new spending power.
    const {
      rows: [row],
    } = await tx.query(
      `WITH balances AS (SELECT
      (EXISTS(SELECT 1 FROM hosted_verifications WHERE "workspaceId"=$1) OR EXISTS(SELECT 1 FROM workspace_credit_grants WHERE "workspaceId"=$1 AND points>0 AND ((bucket='purchased' AND ("expiresAt" IS NULL OR "expiresAt">$3)) OR (bucket='plan' AND ("periodStart" IS NULL OR "periodStart"<=$3) AND ("expiresAt" IS NULL OR "expiresAt">$3))))) AS verified,
      COALESCE((SELECT remaining FROM hosted_allowances WHERE "workspaceId"=$1),0) AS free,
      COALESCE((SELECT sum(GREATEST(0,(g.points::bigint+COALESCE((SELECT sum(r.points) FROM workspace_credit_grants r WHERE r."parentGrantId"=g.id),0))*$2::bigint-COALESCE((SELECT sum(${jsonbSafeBigIntExprSql('u."planAllocations"->>g.id::text')}) FROM hosted_usage u WHERE u."workspaceId"=$1),0)))
        FROM workspace_credit_grants g WHERE g."workspaceId"=$1 AND g.bucket='plan' AND g."parentGrantId" IS NULL AND g.points>0 AND (g."periodStart" IS NULL OR g."periodStart"<=$3) AND (g."expiresAt" IS NULL OR g."expiresAt">$3)),0) AS plan,
      COALESCE((SELECT sum(GREATEST(0,(g.points::bigint+COALESCE((SELECT sum(r.points) FROM workspace_credit_grants r WHERE r."parentGrantId"=g.id),0))*$2::bigint-COALESCE((SELECT sum(${jsonbSafeBigIntExprSql('u."purchasedAllocations"->>g.id::text')}) FROM hosted_usage u WHERE u."workspaceId"=$1),0)))
        FROM workspace_credit_grants g WHERE g."workspaceId"=$1 AND g.bucket='purchased' AND g."parentGrantId" IS NULL AND g.points>0 AND (g."expiresAt" IS NULL OR g."expiresAt">$3)),0)
      -COALESCE((SELECT sum(GREATEST(0,COALESCE((SELECT sum(${jsonbSafeBigIntExprSql('u."purchasedAllocations"->>g.id::text')}) FROM hosted_usage u WHERE u."workspaceId"=$1),0)-(g.points::bigint+COALESCE((SELECT sum(r.points) FROM workspace_credit_grants r WHERE r."parentGrantId"=g.id),0))*$2::bigint))
        FROM workspace_credit_grants g WHERE g."workspaceId"=$1 AND g.bucket='purchased' AND g."parentGrantId" IS NULL AND g.points>0),0)
      -COALESCE((SELECT sum(GREATEST(0,u."purchasedMicroUsd"-COALESCE((SELECT sum(${jsonbSafeBigIntExprSql('v.value')}) FROM jsonb_each_text(COALESCE(u."purchasedAllocations",'{}'::jsonb)) v),0))+CASE WHEN u.state IN ('pending','unknown') THEN u."reservedPurchased" ELSE 0 END) FROM hosted_usage u WHERE u."workspaceId"=$1),0)
      -COALESCE((SELECT sum(-points::bigint)*$2::bigint FROM workspace_credit_grants WHERE "workspaceId"=$1 AND bucket='purchased' AND "parentGrantId" IS NULL AND points<0),0) AS purchased)
      SELECT verified,GREATEST(0,free+LEAST(0,purchased+plan))::float8 AS free,
        GREATEST(0,plan+LEAST(0,purchased))::float8 AS plan,GREATEST(0,purchased)::float8 AS purchased FROM balances`,
      [workspaceId, MICRO_USD_PER_POINT, at],
    )
    return row as { verified: boolean; free: number; plan: number; purchased: number }
  }

  private attribution(workspaceId: string) {
    const scope = hostedBillingScope.getStore()
    return scope?.billingAccountWorkspaceId === workspaceId ? scope : { workspaceId }
  }
  /** Actual receipts plus in-flight holds, serialized by the existing hosted admission lock. */
  private async budget(workspaceId: string, sourceWorkspaceId: string, estimate: number, tx: Query = this.pool, requireCompleteAttribution = true) {
    const { rows } = await tx.query<{ workspaceId: string; limit: number; spent: number }>(`SELECT s."workspaceId",s."monthlyCreditLimit"*$3::float8 AS "limit",
      COALESCE((SELECT sum(CASE WHEN u.state IN ('pending','unknown') THEN COALESCE(u."costMicroUsd",u."holdMicroUsd") ELSE COALESCE(u."costMicroUsd",0) END)
        FROM hosted_usage u WHERE (CASE WHEN s."workspaceId"=$1 THEN u."workspaceId"=s."workspaceId" ELSE COALESCE(u."usageWorkspaceId",u."workspaceId")=s."workspaceId" END)
          AND u.state<>'failed' AND COALESCE(u."billingSource",'credits')='credits'
          AND u."createdAt">=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::float8 AS spent
      FROM workspace_settings s WHERE s."workspaceId"=ANY($2::uuid[]) AND s."monthlyCreditLimit" IS NOT NULL`,
    [workspaceId, [...new Set([workspaceId, sourceWorkspaceId])], MICRO_USD_PER_POINT])
    return rows.every(row => row.limit - row.spent > 0 && row.limit - row.spent >= estimate)
      && resourceBudgetAdmission(tx, workspaceId, this.attribution(workspaceId), estimate, requireCompleteAttribution)
  }
  private async activePaidOveragePolicy(tx: Query, workspaceId: string): Promise<{
    overageEnabled: boolean
    overageMonthlyCapPoints: number | null
  } | null> {
    const { rows: [meta] } = await tx.query<{ available: boolean }>(`SELECT to_regclass('workspace_billing') IS NOT NULL AS available`)
    if (!meta?.available) return null
    const billing = (await tx.query<{
      billingModel: string
      billingExpiresAt: Date | null
      overageEnabled: boolean
      overageMonthlyCapPoints: number | null
    }>(
      `SELECT "billingModel","billingExpiresAt","overageEnabled","overageMonthlyCapPoints"
       FROM workspace_billing WHERE "workspaceId"=$1`,
      [workspaceId],
    )).rows[0]
    if (
      !billing
      || billing.billingModel !== 'resource_v1'
      || !billing.billingExpiresAt
      || billing.billingExpiresAt.getTime() <= Date.now()
    ) return null
    return {
      overageEnabled: billing.overageEnabled,
      overageMonthlyCapPoints: billing.overageMonthlyCapPoints,
    }
  }
  private async overageRefusal(
    tx: Query,
    workspaceId: string,
    balance: { free: number; plan: number; purchased: number },
    flightHeld: number,
    estimate: number,
    isPrepaid = false,
  ): Promise<'usage_budget_exhausted' | 'points_exhausted' | null> {
    const billing = await this.activePaidOveragePolicy(tx, workspaceId)
    if (!billing) return null
    const planBudget = isPrepaid ? balance.plan : balance.free + balance.plan
    const planHeadroom = planBudget - flightHeld
    const spillsPastPlan = planBudget <= 0 || ((isPrepaid || flightHeld > 0) && planHeadroom < estimate)
    if (!spillsPastPlan) return null
    if (!billing.overageEnabled) {
      return balance.purchased > 0 ? 'usage_budget_exhausted' : 'points_exhausted'
    }
    if (billing.overageMonthlyCapPoints !== null) {
      const capMicroUsd = billing.overageMonthlyCapPoints * MICRO_USD_PER_POINT
      const spent = Number((await tx.query<{ n: string }>(
        `SELECT COALESCE(sum("purchasedMicroUsd"+CASE WHEN state IN ('pending','unknown') THEN "reservedPurchased" ELSE 0 END),0)::text AS n
         FROM hosted_usage WHERE "workspaceId"=$1 AND state<>'failed' AND COALESCE("billingSource",'credits')='credits'
           AND "createdAt">=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        [workspaceId],
      )).rows[0].n)
      const inFlightOverage = Math.max(0, flightHeld - Math.max(0, planBudget))
      const neededOverage = Math.max(0, estimate - Math.max(0, planHeadroom))
      if (capMicroUsd - spent - inFlightOverage <= 0 || capMicroUsd - spent - inFlightOverage < neededOverage) {
        return 'usage_budget_exhausted'
      }
    }
    return null
  }
  async canUseMikkaPaid(workspaceId: string) {
    const balance = await this.balance(workspaceId)
    if (!this.metered) return balance
    if (!await this.budget(workspaceId, this.attribution(workspaceId).workspaceId, 0)) throw new PaidResourceError('usage_budget_exhausted')
    // No trial (decision 2026-11-15-1900): an unfunded workspace spends nothing.
    if (balance.free + balance.plan + balance.purchased <= 0) throw new PaidResourceError('points_exhausted')
    const overageRefusal = await this.overageRefusal(this.pool, workspaceId, balance, 0, HOSTED_CALL_HOLD_MICRO_USD)
    if (overageRefusal) throw new PaidResourceError(overageRefusal)
    return balance
  }
  /** Holds and slots of this workspace's calls that have not settled. */
  private async inFlight(tx: Query, workspaceId: string) {
    const {
      rows: [row],
    } = await tx.query(
      `SELECT COALESCE(sum("holdMicroUsd"),0)::float8 AS held, count(*) FILTER (WHERE state='pending')::int AS calls
       FROM hosted_usage WHERE "workspaceId"=$1 AND state IN ('pending','unknown') AND NOT (${abandonedHold})`,
      [workspaceId],
    )
    return row as { held: number; calls: number }
  }
  async reserve(
    workspaceId: string,
    model: string,
    id: string,
    env: EnvMap = runtimeEnv(),
    estimate = HOSTED_CALL_HOLD_MICRO_USD,
    prepaid: boolean | { machineMeter: Record<string, unknown> } = false,
  ) {
    if (!this.metered) return { id, workspaceId }
    if (!Number.isSafeInteger(estimate) || estimate <= 0) throw new Error('invalid_usage_hold')
    const attribution = this.attribution(workspaceId)
    // Resolve WS identity before pinning either pool's transaction. WS and APP
    // can both have max=1; no cross-database JOIN or nested pool checkout occurs.
    // Pin plan authority before reserving an APP connection, matching the
    // workspace -> APP order used by task and governance writers.
    const quota = await this.quota?.(attribution.workspaceId)
    try { return await this.transaction(async (tx) => {
      // One short platform admission lock; no SQL lock spans provider I/O.
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('hosted-free-budget',0))",
      )
      await this.lock(tx, workspaceId)
      // Product concurrency never grants spending authority or a free allowance.
      if (quota?.billingAccount) {
        const current = quota.billingAccount
        if (current.organizationId !== (attribution.billingOrganizationId ?? null)
          || (current.organizationId && current.workspaceId !== workspaceId)) throw new PaidResourceError('billing_authorization_revoked')
      }
      if (attribution.creditShareOwnerId) {
        const share = await tx.query('select 1 from workspace_credit_shares where "workspaceId"=$1 and "userId"=$2 for share', [attribution.workspaceId, attribution.creditShareOwnerId])
        if (!share.rows.length) throw new PaidResourceError('billing_authorization_revoked')
      }
      // Release an abandoned reservation so one stuck call never keeps its hold.
      // A hosted call runs at most HOSTED_CALL_TIMEOUT_MS; a pending row past a
      // wide margin crashed before settling, and an unknown row with no
      // generationId can never be reconciled (the cost lookup needs it).
      await this.releaseAbandoned(tx, workspaceId)
      const prior = (
        await tx.query('SELECT state FROM hosted_usage WHERE id=$1', [id])
      ).rows[0]
      if (prior) throw new PaidResourceError('usage_in_progress') // Never replay a paid provider call.
      if (!await this.budget(workspaceId, attribution.workspaceId, estimate, tx)) throw new PaidResourceError('usage_budget_exhausted')
      const balance = await this.balance(workspaceId, tx)
      // No trial: nothing is admitted without plan, purchased or previously granted free credit.
      const available = balance.free + balance.plan + balance.purchased
      if (available <= 0) throw new PaidResourceError('points_exhausted')
      const flight = await this.inFlight(tx, workspaceId)
      if (prepaid && balance.plan + balance.purchased - flight.held < estimate)
        throw new PaidResourceError('points_exhausted')
      if (!prepaid && flight.calls >= (quota?.limit ?? HOSTED_MAX_IN_FLIGHT_PER_WORKSPACE))
        throw new PaidResourceError('usage_concurrency_limit')
      // Concurrent calls must fit the balance together. A lone call is admitted
      // on any positive balance, as before, so the last cents stay usable.
      if (flight.held > 0 && available - flight.held < estimate)
        throw new PaidResourceError('points_exhausted')
      const overageRefusal = await this.overageRefusal(tx, workspaceId, balance, flight.held, estimate, Boolean(prepaid))
      if (overageRefusal) throw new PaidResourceError(overageRefusal)
      const limit = abuseLimits(env)
      const spent = Number(
        (
          await tx.query(
            `SELECT COALESCE(sum("unpaidMicroUsd"+CASE WHEN state IN ('pending','unknown') THEN "reservedUnpaid" ELSE 0 END),0) AS n FROM hosted_usage WHERE "createdAt">now()-interval '24 hours'`,
          )
        ).rows[0].n,
      )
      if (spent >= limit.dailyMicroUsd && balance.plan + balance.purchased <= 0)
        throw new PaidResourceError('platform_paused')
      // The hold only gates admission; settlement charges the actual cost.
      await tx.query(
        `INSERT INTO hosted_usage (id,"workspaceId",model,state,"holdMicroUsd","usageWorkspaceId","billingOrganizationId","executionOwnerId","actorId","usageProjectId","usageThreadId","usageRunId","attributionComplete","billingSource","usageTurnRef")
          VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, workspaceId, model, estimate, attribution.workspaceId, attribution.billingOrganizationId ?? null, attribution.ownerId ?? null,
          attribution.actorId ?? attribution.ownerId ?? null, attribution.projectId ?? null, attribution.threadId ?? null, attribution.runId ?? null, attribution.attributionComplete ?? false, attribution.billingSource ?? null,
          isUsageTurnRef(attribution.turnRef) ? attribution.turnRef : null],
      )
      if (prepaid === true) await this.settleLocked(tx, id, estimate, 0, 0, undefined, undefined, undefined, true)
      else if (prepaid) await tx.query(`UPDATE hosted_usage SET state='unknown',"generationId"=$2,"machineCompute"=$3::jsonb,"machineComputeReviewAt"=now()+interval '5 minutes' WHERE id=$1`,
        [id, 'cf-cgroup:' + id, JSON.stringify(prepaid.machineMeter)])
      return { id, workspaceId }
    }) } finally { await quota?.close() }
  }
  /** Persist the upstream lookup identity before exposing its first content. */
  async recordGeneration(id: string, generationId: string) {
    if (!this.metered) return
    if (!generationId || generationId.length > 200) throw new Error('invalid_usage_generation')
    const result = await this.pool.query(
      `UPDATE hosted_usage SET "generationId"=COALESCE("generationId",$2)
       WHERE id=$1 AND state IN ('pending','unknown')
         AND ("generationId" IS NULL OR "generationId"=$2) RETURNING id`,
      [id, generationId],
    )
    if (!result.rowCount) throw new PaidResourceError('usage_cost_unavailable')
  }
  /**
   * `cache` is a breakdown of `inputTokens`, never an addition to it: the
   * provider's input total already includes cached input. Omitted or null means
   * "this receipt carried no cache figures", which is stored as NULL and must
   * never be read as zero. A call that never got a finish receipt (interrupted,
   * cancelled, provider unknown) leaves both columns NULL for that reason.
   */
  async settle(
    id: string,
    cost: number | null,
    inputTokens = 0,
    outputTokens = 0,
    generationId?: string,
    cache?: { read: number | null; write: number | null } | null,
    messageId?: string | null,
  ) {
    if (!this.metered) return
    return this.transaction(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('hosted-free-budget',0))",
      )
      await this.settleLocked(tx, id, cost, inputTokens, outputTokens, generationId, cache, messageId)
    })
  }

  async settleMeasuredMachine(id: string, cost: number, usage: Record<string, unknown>) {
    if (!this.metered) return
    return this.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('hosted-free-budget',0))")
      const held = await tx.query(`UPDATE hosted_usage SET "machineCompute"="machineCompute"||$2::jsonb,"machineComputeReviewAt"=NULL
        WHERE id=$1 AND state='unknown' AND "generationId"=$3 AND "holdMicroUsd">=$4 RETURNING id`,
      [id, JSON.stringify(usage), 'cf-cgroup:' + id, cost])
      if (held.rowCount) await this.settleLocked(tx, id, cost, 0, 0, undefined, undefined, undefined, true)
    })
  }

  /** A lost provider receipt cannot authorize an estimate or retain credits indefinitely. */
  async expireMeasuredMachine(id: string) {
    if (!this.metered) return false
    const expired = await this.pool.query(`UPDATE hosted_usage SET state='failed',"settledAt"=now(),${releaseMachineHold}
      WHERE id=$1 AND (${expiredMachineHold})`, [id])
    return Boolean(expired.rowCount)
  }

  private async allocateBucketGrants(
    tx: Query,
    workspaceId: string,
    bucket: 'plan' | 'purchased',
    amountMicroUsd: number,
    createdAt: Date,
  ): Promise<{ allocated: number; allocations: Record<string, number> }> {
    const allocations: Record<string, number> = {}
    if (amountMicroUsd <= 0) return { allocated: 0, allocations }
    const col = bucket === 'plan' ? 'planAllocations' : 'purchasedAllocations'
    const periodFilter = bucket === 'plan' ? `AND (g."periodStart" IS NULL OR g."periodStart"<=$3)` : ''
    const grants = await tx.query<{ id: string; remaining: number }>(
      `SELECT g.id,GREATEST(0,(g.points::bigint+COALESCE((SELECT sum(r.points) FROM workspace_credit_grants r WHERE r."parentGrantId"=g.id),0))*$2::bigint-COALESCE((SELECT sum(${jsonbSafeBigIntExprSql(`u."${col}"->>g.id::text`)}) FROM hosted_usage u WHERE u."workspaceId"=$1),0))::float8 AS remaining
       FROM workspace_credit_grants g WHERE g."workspaceId"=$1 AND g.bucket='${bucket}' AND g."parentGrantId" IS NULL AND g.points>0 ${periodFilter} AND (g."expiresAt" IS NULL OR g."expiresAt">$3)
       ORDER BY g."expiresAt" ASC NULLS LAST,g.id`,
      [workspaceId, MICRO_USD_PER_POINT, createdAt],
    )
    let remaining = amountMicroUsd
    for (const grant of grants.rows) {
      const amount = Math.min(remaining, grant.remaining)
      if (amount > 0) allocations[grant.id] = amount
      remaining -= amount
      if (remaining === 0) break
    }
    return { allocated: amountMicroUsd - remaining, allocations }
  }

  private async settleLocked(
    tx: Query,
    id: string,
    cost: number | null,
    inputTokens: number,
    outputTokens: number,
    generationId?: string,
    cache?: { read: number | null; write: number | null } | null,
    messageId?: string | null,
    prepaid = false,
  ) {
    const row = (
      await tx.query('SELECT * FROM hosted_usage WHERE id=$1 FOR UPDATE', [
        id,
      ])
    ).rows[0]
    if (!row || row.state === 'settled' || row.state === 'failed') return
    await this.lock(tx, row.workspaceId)
    if (generationId && row.generationId && generationId !== row.generationId)
      throw new Error('usage_generation_mismatch')
    if (messageId) {
      await tx.query('UPDATE hosted_usage SET "usageMessageId"=COALESCE("usageMessageId",$2) WHERE id=$1', [id, messageId])
    }
    const cacheValue = (value: number | null) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
    const cacheColumns = [cacheValue(cache?.read ?? null), cacheValue(cache?.write ?? null)]
    // Unknown cost never means free. Retain the receipt record and keep its hold
    // until the receipt is reconciled using this same method.
    if (cost === null) {
      await tx.query(
        `UPDATE hosted_usage SET state='unknown',"generationId"=COALESCE($2,"generationId"),
         "inputTokens"=GREATEST("inputTokens",$3),"outputTokens"=GREATEST("outputTokens",$4),
         "cacheReadTokens"=COALESCE($5,"cacheReadTokens"),"cacheWriteTokens"=COALESCE($6,"cacheWriteTokens") WHERE id=$1`,
        [id, generationId ?? null, inputTokens, outputTokens, ...cacheColumns],
      )
      return
    }
    if (!Number.isSafeInteger(cost) || cost < 0)
      throw new Error('invalid_usage_cost')
    // Never invent cache figures. Only finite nonnegative integers reach the
    // ledger; anything else is "not collected" and stays NULL.
    // A call admitted just before the period ended keeps access to that paid
    // period's remaining grant; it never consumes a future period's allowance.
    const available = await this.balance(row.workspaceId, tx, row.createdAt)
    const legacyRow = Number(row.reservedFree) > 0 || Number(row.reservedPurchased) > 0 || Number(row.reservedUnpaid) > 0
    // Who funded the cost is written once, here, as "platformMicroUsd" (#2934): the part the platform paid.
    // The workspace was charged the rest: plan allowance, purchased credit and any overrun debt it owes.
    // Free credit (a hosted_allowances grant) and a free-message turn are the platform's, never a charge.
    // A free-message turn (no card, nothing bought): the platform pays, as unpaid spend under its daily cap,
    // never as a debt the workspace's allowance would repay once a card is verified.
    if (prepaid && available.plan + available.purchased < cost) throw new PaidResourceError('points_exhausted')
    if (!prepaid && !legacyRow && !available.verified && available.purchased <= 0) {
      await tx.query(
        `UPDATE hosted_usage SET state='settled',"costMicroUsd"=$2,"freeMicroUsd"=0,"purchasedMicroUsd"=0,"inputTokens"=$3,"outputTokens"=$4,"generationId"=COALESCE($5,"generationId"),"unpaidMicroUsd"=$2,"platformMicroUsd"=$2,"cacheReadTokens"=$6,"cacheWriteTokens"=$7,"settledAt"=now() WHERE id=$1`,
        [id, cost, inputTokens, outputTokens, generationId ?? null, ...cacheColumns],
      )
      return
    }
    // Old rows may already have debited free credit or frozen purchased points.
    // Settle those exact rows without charging their prepaid money twice.
    const legacy = Number(row.reservedFree) > 0 || Number(row.reservedPurchased) > 0 || Number(row.reservedUnpaid) > 0
    const spent = Number((await tx.query(`SELECT COALESCE(sum("unpaidMicroUsd"+CASE WHEN state IN ('pending','unknown') THEN "reservedUnpaid" ELSE 0 END),0) AS n FROM hosted_usage WHERE "createdAt">now()-interval '24 hours'`)).rows[0].n)
    const useFree = prepaid ? false : legacy ? Number(row.reservedFree) > 0 : spent < abuseLimits().dailyMicroUsd
    const free =
      useFree
        ? Math.min(cost, Number(row.reservedFree) + available.free)
        : 0
    const remainingPlan = Math.min(cost - free, available.plan)
    const { allocated: plan, allocations } = await this.allocateBucketGrants(tx, row.workspaceId, 'plan', remainingPlan, row.createdAt)
    if (plan !== remainingPlan) throw new Error('billing_plan_allocation_changed')
    const excess = cost - free - plan
    const overagePolicy = excess > 0 ? await this.activePaidOveragePolicy(tx, row.workspaceId) : null
    let maxOverage = excess
    if (overagePolicy) {
      if (!overagePolicy.overageEnabled) {
        maxOverage = 0
      } else if (overagePolicy.overageMonthlyCapPoints !== null) {
        const capMicroUsd = overagePolicy.overageMonthlyCapPoints * MICRO_USD_PER_POINT
        const confirmedSpent = Number((await tx.query<{ n: string }>(
          `SELECT COALESCE(sum("purchasedMicroUsd"),0)::text AS n
           FROM hosted_usage WHERE "workspaceId"=$1 AND state<>'failed' AND COALESCE("billingSource",'credits')='credits'
             AND "createdAt">=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
          [row.workspaceId],
        )).rows[0].n)
        maxOverage = Math.max(0, capMicroUsd - confirmedSpent)
      }
    }
    const purchased = Math.min(excess, maxOverage)
    const unauthorizedOverage = excess - purchased
    const allocatablePurchased = Math.min(purchased, Number(row.reservedPurchased) + available.purchased)
    const { allocations: purchasedAllocations } = await this.allocateBucketGrants(tx, row.workspaceId, 'purchased', allocatablePurchased, row.createdAt)
    const unpaid =
      (useFree
        ? free +
          Math.max(
            0,
            purchased - available.purchased - Number(row.reservedPurchased),
          )
        : 0) + unauthorizedOverage // Any one-call overrun stays as debt; unauthorized overage never drains protected purchased credits.
    // "unpaidMicroUsd" counts free credit and debt together for the platform's daily cap, so it cannot
    // say who paid. The platform funded `free` alone; plan, purchased and debt are charged.
    await tx.query(
      'UPDATE hosted_allowances SET remaining=remaining+$2-$3 WHERE "workspaceId"=$1',
      [row.workspaceId, Number(row.reservedFree), free],
    )
    await tx.query(
      `UPDATE hosted_usage SET state='settled',"costMicroUsd"=$2,"freeMicroUsd"=$3,"purchasedMicroUsd"=$4,"inputTokens"=$5,"outputTokens"=$6,"generationId"=COALESCE($7,"generationId"),"unpaidMicroUsd"=$8,"planMicroUsd"=$9,"planAllocations"=$10,"purchasedAllocations"=$11,"cacheReadTokens"=$12,"cacheWriteTokens"=$13,"platformMicroUsd"=$3,"settledAt"=now() WHERE id=$1`,
      [
        id,
        cost,
        free,
        purchased,
        inputTokens,
        outputTokens,
        generationId ?? null,
        unpaid,
        plan,
        JSON.stringify(allocations),
        JSON.stringify(purchasedAllocations),
        ...cacheColumns,
      ],
    )
  }
  async status(
    workspaceId: string,
    env: EnvMap = runtimeEnv(),
  ) {
    const balance = await this.balance(workspaceId)
    if (!this.metered) return { state: 'ready', balance }
    const flight = await this.inFlight(this.pool, workspaceId)
    const spent = Number(
      (
        await this.pool.query(
          `SELECT COALESCE(sum("unpaidMicroUsd"+CASE WHEN state IN ('pending','unknown') THEN "reservedUnpaid" ELSE 0 END),0) AS n FROM hosted_usage WHERE "createdAt">now()-interval '24 hours'`,
        )
      ).rows[0].n,
    )
    // Whether the next call would be admitted, by the same rules as reserve().
    const available = balance.free + balance.plan + balance.purchased
    // A billing page has no particular Project/Thread/Run. It summarizes the
    // known scopes; reserve() still requires complete execution attribution.
    const withinBudget = await this.budget(workspaceId, this.attribution(workspaceId).workspaceId, HOSTED_CALL_HOLD_MICRO_USD, this.pool, false)
    const overageRefusal = await this.overageRefusal(this.pool, workspaceId, balance, flight.held, HOSTED_CALL_HOLD_MICRO_USD)
    // These pool reads retain no APP connection. Once the plan is pinned,
    // status computes the response without acquiring another APP connection.
    const quota = await this.quota?.(this.attribution(workspaceId).workspaceId)
    try {
    const state = !withinBudget ? 'usage_budget_exhausted'
      : available <= 0
        ? 'points_exhausted'
        : overageRefusal
          ? overageRefusal
          : flight.calls >= (quota?.limit ?? HOSTED_MAX_IN_FLIGHT_PER_WORKSPACE)
            ? 'usage_concurrency_limit'
            : flight.held > 0 && available - flight.held < HOSTED_CALL_HOLD_MICRO_USD
              ? 'points_exhausted'
              : spent >= abuseLimits(env).dailyMicroUsd && balance.plan + balance.purchased <= 0
                ? 'platform_paused'
                : 'ready'
    return { state, balance }
    } finally { await quota?.close() }
  }
  async recent(workspaceId: string, sourceWorkspaceId?: string) {
    if (!this.metered) return []
    return (
      await this.pool.query(
        `SELECT id,model,state,"costMicroUsd","freeMicroUsd","planMicroUsd","purchasedMicroUsd","inputTokens","outputTokens","createdAt","usageWorkspaceId","billingOrganizationId" FROM hosted_usage WHERE "workspaceId"=$1
          AND COALESCE("billingSource",'credits')='credits'
          AND ($2::uuid IS NULL OR COALESCE("usageWorkspaceId","workspaceId")=$2::uuid) ORDER BY "createdAt" DESC LIMIT 50`,
        [workspaceId, sourceWorkspaceId ?? null],
      )
    ).rows
  }

  /**
   * Adjusts a settled prepaid machine chunk downward after actual awake seconds are observed.
   * Refunds LIFO across allocations so available credits and monthly overage headroom recover immediately.
   */
  async adjustSettledMachineCost(
    id: string,
    workspaceId: string,
    ownerId: string,
    targetCostMicroUsd: number,
    existingTx?: Query,
  ): Promise<{ adjusted: boolean; refundedMicroUsd: number }> {
    if (!this.metered) return { adjusted: false, refundedMicroUsd: 0 }
    if (!Number.isSafeInteger(targetCostMicroUsd) || targetCostMicroUsd < 0) {
      throw new Error('invalid_usage_cost')
    }
    const apply = async (tx: Query) => {
      const row = (
        await tx.query(
          'SELECT * FROM hosted_usage WHERE id=$1 AND COALESCE("usageWorkspaceId","workspaceId")=$2 AND "executionOwnerId" IS NOT DISTINCT FROM $3 FOR UPDATE',
          [id, workspaceId, ownerId],
        )
      ).rows[0]
      if (!row || row.state !== 'settled' || row.costMicroUsd === null) {
        return { adjusted: false, refundedMicroUsd: 0 }
      }
      await this.lock(tx, row.workspaceId)
      const oldCost = Number(row.costMicroUsd)
      if (!Number.isFinite(oldCost) || targetCostMicroUsd >= oldCost) {
        return { adjusted: false, refundedMicroUsd: 0 }
      }
      let remainingReduction = oldCost - targetCostMicroUsd
      let unpaid = Number(row.unpaidMicroUsd ?? 0)
      let free = Number(row.freeMicroUsd ?? 0)
      let plan = Number(row.planMicroUsd ?? 0)
      let purchased = Number(row.purchasedMicroUsd ?? 0)
      const planAllocations = { ...(row.planAllocations as Record<string, number> | null) }
      const purchasedAllocations = { ...(row.purchasedAllocations as Record<string, number> | null) }

      const nonFreeUnpaid = Math.max(0, unpaid - free)
      const unpaidReduce = Math.min(remainingReduction, nonFreeUnpaid)
      unpaid -= unpaidReduce
      remainingReduction -= unpaidReduce

      const lifoGrantIds = async (allocations: Record<string, number>) => {
        const ids = Object.keys(allocations)
        if (!ids.length) return []
        const { rows } = await tx.query<{ id: string }>(
          `SELECT id FROM workspace_credit_grants
           WHERE "workspaceId"=$1 AND id = ANY($2::uuid[])
           ORDER BY "expiresAt" DESC NULLS FIRST, id DESC`,
          [row.workspaceId, ids],
        )
        return rows.map(grant => grant.id)
      }

      const purchasedReduce = Math.min(remainingReduction, purchased)
      purchased -= purchasedReduce
      remainingReduction -= purchasedReduce
      if (purchasedReduce > 0) {
        reduceBucketAllocations(purchasedAllocations, purchased, await lifoGrantIds(purchasedAllocations))
      }

      const planReduce = Math.min(remainingReduction, plan)
      plan -= planReduce
      remainingReduction -= planReduce
      if (planReduce > 0) {
        reduceBucketAllocations(planAllocations, plan, await lifoGrantIds(planAllocations))
      }

      const freeReduce = Math.min(remainingReduction, free)
      free -= freeReduce
      unpaid = Math.max(0, unpaid - freeReduce)
      if (freeReduce > 0) {
        await tx.query(
          'UPDATE hosted_allowances SET remaining=remaining+$2 WHERE "workspaceId"=$1',
          [row.workspaceId, freeReduce],
        )
      }

      const nextState = targetCostMicroUsd === 0 ? 'failed' : 'settled'
      await tx.query(
        `UPDATE hosted_usage SET state=$2,"costMicroUsd"=$3,"freeMicroUsd"=$4,"purchasedMicroUsd"=$5,
          "unpaidMicroUsd"=$6,"planMicroUsd"=$7,"planAllocations"=$8,"purchasedAllocations"=$9,"platformMicroUsd"=$4
         WHERE id=$1`,
        [
          id,
          nextState,
          targetCostMicroUsd,
          free,
          purchased,
          unpaid,
          plan,
          JSON.stringify(planAllocations),
          JSON.stringify(purchasedAllocations),
        ],
      )
      return { adjusted: true, refundedMicroUsd: oldCost - targetCostMicroUsd }
    }
    return existingTx ? apply(existingTx) : this.transaction(apply)
  }
}
