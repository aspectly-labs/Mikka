import 'server-only'
import { randomUUID } from 'node:crypto'
import { AuthenticationError, NotFoundError, Sandbox, SandboxNotFoundError, type SandboxApiOpts, type SandboxInfo } from 'e2b'
import type { Pool, PoolClient } from 'pg'
import { pool } from '@/lib/db'
import { isCloudEdition } from '@/lib/edition'
import { e2bResourceAccount } from '@/lib/secrets/e2b-resource'
import { armDueTimerSoon } from '@/lib/due-timer'
import { E2BKeyError } from '@/lib/secrets/flag'
import { e2bPricingForHardware, e2bTemplatePricing, type E2BComputeSpec } from './e2b-template-pricing'
import { fundMachineChunk } from './machine-billing'
import { MACHINE_CHUNK_MS, type E2BMachineSize } from './machine-pricing'

export const E2B_RENEW_LEAD_MS = 45_000
export const E2B_TIMEOUT_REQUEST_BUDGET_MS = 5_000
const unavailable = () => new E2BKeyError('e2b_unavailable', 'E2B compute billing identity unavailable')

type Lease = { operationId: string; ownerId: string; workspaceId: string; providerScope: string;
  templateId: string; size: E2BMachineSize; hourlyMicroUsd: number; pricingVersion: string; chunkIndex: number }
type Target = { workspaceId: string; runId: string | null }
type KeepAlivePayment = { operationId?: string; index?: number; activated?: number; dispatchId?: string; baselineDeadline?: Date }

async function paidTimeout(lease: Lease, target: Target, requestedMs: number, renew = true, creation = false, beforeRenew?: () => Promise<unknown>, payment?: KeepAlivePayment): Promise<number> {
  const claim = renew ? (await pool.query<{ chunkIndex: number; pendingRunId: string | null }>(
    `UPDATE e2b_compute_leases SET "pendingAt"=coalesce("pendingAt",greatest(now(),"paidUntil")),
        "pendingRunId"=CASE WHEN "pendingAt" IS NULL THEN $2 ELSE "pendingRunId" END,
        "fundingOpenedAt"=coalesce("fundingOpenedAt",clock_timestamp())
      WHERE "operationId"=$1 AND ("paidUntil" IS NULL OR "paidUntil"<=now()+$3::int*interval '1 millisecond')
        AND (NOT $4::boolean OR "chunkIndex"=-1) AND "renewalReviewAt" IS NULL
        AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE id=$2 AND "stopRequestedAt" IS NOT NULL)
      RETURNING "chunkIndex","pendingRunId"`, [lease.operationId, target.runId, E2B_RENEW_LEAD_MS, creation])).rows[0] : undefined
  if (claim) {
    armDueTimerSoon('run-recovery')
    await beforeRenew?.()
    const index = claim.chunkIndex + 1
    const funded = await fundMachineChunk({ provider: 'e2b', ownerId: lease.ownerId, workspaceId: target.workspaceId, runId: claim.pendingRunId,
      operationId: lease.operationId, index, size: lease.size, hourlyMicroUsd: lease.hourlyMicroUsd })

    // Settlement precedes activation. A lost response reuses this exact chunk;
    // concurrent confirmations advance the paid deadline only once.
    if (funded) {
      const activation = await pool.query(`UPDATE e2b_compute_leases SET "chunkIndex"=$2,"previousPaidUntil"="paidUntil",
        "previousActiveChunkIndex"="activeChunkIndex","activeChunkIndex"=$2,
        "paidUntil"=greatest(now(),"paidUntil")+$3::int*interval '1 millisecond',
        "renewalReviewAt"=CASE WHEN "sandboxId" IS NOT NULL THEN clock_timestamp()+interval '30 seconds' ELSE NULL END,
        "renewalDispatchId"=NULL,"renewalDispatchUntil"=NULL,"renewalUnchangedAt"=NULL,"renewalBaselineDeadline"=NULL,
        "pendingAt"=NULL,"pendingRunId"=NULL,"fundingOpenedAt"=NULL
        WHERE "operationId"=$1 AND "chunkIndex"=$2-1`, [lease.operationId, index, MACHINE_CHUNK_MS])
      if (activation.rowCount && !creation) {
        if (payment) payment.activated = index
        armDueTimerSoon('run-recovery')
      }
    }
    // A concurrent refusal may clear admission for the next attempt but must
    // leave evidence that this exact interval could already have settled.
    else await pool.query(`UPDATE e2b_compute_leases SET "pendingAt"=NULL,"pendingRunId"=NULL
      WHERE "operationId"=$1 AND "chunkIndex"=$2-1 AND "pendingRunId" IS NOT DISTINCT FROM $3::uuid`,
    [lease.operationId, index, claim.pendingRunId])
  }
  const { rows: [row] } = await pool.query<{ remainingMs: number; chunkIndex: number }>(
    `SELECT "activeChunkIndex" AS "chunkIndex",floor(extract(epoch FROM ("paidUntil"-clock_timestamp()))*1000)::int AS "remainingMs"
      FROM e2b_compute_leases WHERE "operationId"=$1`, [lease.operationId])
  // E2B rounds up to seconds. Use whole seconds and allow for provider request latency.
  const seconds = Math.floor((Math.min(requestedMs, row?.remainingMs ?? 0, MACHINE_CHUNK_MS + E2B_RENEW_LEAD_MS) - E2B_TIMEOUT_REQUEST_BUDGET_MS - 1_000) / 1_000)
  if (seconds < 1) throw new E2BKeyError('e2b_limit_reached', 'Mikka credits are insufficient for five minutes of compute')
  if (payment) {
    payment.operationId = lease.operationId
    payment.index = row.chunkIndex
  }
  return seconds * 1_000
}

async function useE2BKeepAlivePayment(query: Pick<Pool, 'query'>, ownerId: string, payment: KeepAlivePayment, observed = false) {
  if (!payment.operationId) return true
  const result = await query.query(`UPDATE e2b_compute_leases l SET "usedChunkIndex"=greatest("usedChunkIndex",$3),"renewalReviewAt"=NULL,
      "renewalDispatchId"=NULL,"renewalDispatchUntil"=NULL,"renewalUnchangedAt"=NULL,"renewalBaselineDeadline"=NULL
    WHERE "operationId"=$1 AND "ownerId"=$2 AND "activeChunkIndex"=$3 AND ($4::boolean OR "paidUntil">clock_timestamp())
      AND EXISTS (SELECT 1 FROM hosted_usage u WHERE u.id='machine:e2b:'||l."operationId"||':'||$3::int
        AND u."executionOwnerId"=$2 AND u."usageWorkspaceId"=l."workspaceId" AND u.state='settled')`,
  [payment.operationId, ownerId, payment.index, observed])
  return result.rowCount === 1
}

/** Record possible external I/O before taking the APP lifecycle locks.
 * A rollback or a crashed process therefore cannot turn a sent request into
 * an apparently untouched prepayment. An expired ticket cannot send. */
async function prepareE2BKeepAliveDispatch(ownerId: string, payment: KeepAlivePayment, inspect: () => Promise<SandboxInfo>) {
  if (!payment.operationId) return
  if (!payment.baselineDeadline) {
    const waiting = await pool.query(`SELECT 1 FROM e2b_compute_leases WHERE "operationId"=$1 AND "ownerId"=$2 AND "activeChunkIndex"=$3
      AND "renewalReviewAt">clock_timestamp() AND "renewalDispatchId" IS NULL AND "usedChunkIndex"<$3`,
    [payment.operationId, ownerId, payment.index])
    if (!waiting.rowCount) return
    payment.baselineDeadline = (await inspect()).endAt
  }
  const id = randomUUID()
  payment.dispatchId = id
  const marked = await pool.query(`UPDATE e2b_compute_leases SET "renewalDispatchId"=$4,
    "renewalDispatchUntil"=clock_timestamp()+interval '15 seconds',
    "renewalReviewAt"=clock_timestamp()+interval '30 seconds',"renewalBaselineDeadline"=$5
    WHERE "operationId"=$1 AND "ownerId"=$2 AND "activeChunkIndex"=$3
      AND "renewalReviewAt">clock_timestamp() AND "renewalDispatchId" IS NULL AND "usedChunkIndex"<$3`,
  [payment.operationId, ownerId, payment.index, id, payment.baselineDeadline ?? null])
  if (!marked.rowCount) payment.dispatchId = undefined
}

async function lockE2BKeepAliveDispatch(query: Pick<Pool, 'query'>, ownerId: string, payment: KeepAlivePayment) {
  if (!payment.operationId) return { dispatchBefore: Number.POSITIVE_INFINITY }
  const { rows: [row] } = await query.query<{ dispatchBefore: Date }>(`SELECT least("paidUntil",
    CASE WHEN $3=0 OR "usedChunkIndex">=$3 THEN "paidUntil" ELSE "renewalDispatchUntil" END) AS "dispatchBefore"
    FROM e2b_compute_leases WHERE "operationId"=$1 AND "ownerId"=$2 AND "activeChunkIndex"=$3
      AND "paidUntil">clock_timestamp() AND ($3=0 OR "usedChunkIndex">=$3
        OR ("renewalDispatchId"=$4 AND "renewalDispatchUntil">clock_timestamp())) FOR UPDATE`,
  [payment.operationId, ownerId, payment.index, payment.dispatchId ?? null])
  return row && { dispatchBefore: row.dispatchBefore.getTime() }
}

async function releaseE2BKeepAlivePayment(ownerId: string, payment: KeepAlivePayment) {
  if (!payment.operationId) return
  if (payment.dispatchId) await pool.query(`UPDATE e2b_compute_leases SET "renewalDispatchId"=NULL,"renewalDispatchUntil"=NULL
    WHERE "operationId"=$1 AND "ownerId"=$2 AND "activeChunkIndex"=$3 AND "renewalDispatchId"=$4`,
  [payment.operationId, ownerId, payment.index, payment.dispatchId])
  if (payment.activated !== undefined)
    await refundUnusedRenewal(ownerId, payment.operationId, payment.activated)
}

async function refundUnusedRenewal(ownerId: string, operationId: string, index: number, dispatchId?: string) {
  await pool.query(`WITH unused AS (
    UPDATE e2b_compute_leases SET "paidUntil"="previousPaidUntil","previousPaidUntil"=NULL,
      "activeChunkIndex"="previousActiveChunkIndex","renewalReviewAt"=NULL,
      "renewalDispatchId"=NULL,"renewalDispatchUntil"=NULL,"renewalUnchangedAt"=NULL,"renewalBaselineDeadline"=NULL
      WHERE "operationId"=$1 AND "ownerId"=$2 AND "activeChunkIndex"=$3 AND "chunkIndex"=$3 AND "usedChunkIndex"<$3
        AND "renewalDispatchId" IS NOT DISTINCT FROM $5::uuid
        AND ($5::uuid IS NULL OR "renewalUnchangedAt"<clock_timestamp()-interval '29 seconds')
      RETURNING "workspaceId"
    ) UPDATE hosted_usage u SET state='failed',"costMicroUsd"=0,"purchasedMicroUsd"=0,"planMicroUsd"=0,"planAllocations"='{}'
    FROM unused WHERE u.id=$4 AND u."usageWorkspaceId"=unused."workspaceId" AND u."executionOwnerId"=$2 AND u.state='settled'`,
  [operationId, ownerId, index, `machine:e2b:${operationId}:${index}`, dispatchId ?? null])
}

export async function reconcileE2BKeepAlivePayments() {
  if (!isCloudEdition()) return
  // A settled but unactivated interval never authorized an external request.
  await pool.query(`WITH due AS (
    SELECT l."operationId" FROM e2b_compute_leases l WHERE l."sandboxId" IS NOT NULL
      AND coalesce(l."fundingOpenedAt",l."pendingAt")<=clock_timestamp()-interval '5 minutes'
      AND EXISTS (SELECT 1 FROM hosted_usage u WHERE u.id='machine:e2b:'||l."operationId"||':'||(l."chunkIndex"+1)
        AND u."executionOwnerId"=l."ownerId" AND u."usageWorkspaceId"=l."workspaceId" AND u.state='settled')
    ORDER BY coalesce(l."fundingOpenedAt",l."pendingAt") LIMIT 20 FOR UPDATE SKIP LOCKED
  ), cancelled AS (
    UPDATE e2b_compute_leases l SET "chunkIndex"="chunkIndex"+1,"pendingAt"=NULL,"pendingRunId"=NULL,"fundingOpenedAt"=NULL
    FROM due WHERE l."operationId"=due."operationId" RETURNING l."operationId",l."ownerId",l."workspaceId",l."chunkIndex"
  ) UPDATE hosted_usage u SET state='failed',"costMicroUsd"=0,"purchasedMicroUsd"=0,"planMicroUsd"=0,"planAllocations"='{}'
    FROM cancelled l WHERE u.id='machine:e2b:'||l."operationId"||':'||l."chunkIndex"
      AND u."executionOwnerId"=l."ownerId" AND u."usageWorkspaceId"=l."workspaceId" AND u.state='settled'`)
  const { rows } = await pool.query<{ operationId: string; ownerId: string; activeChunkIndex: number;
    sandboxId: string; providerScope: string; renewalDispatchId: string | null;
    renewalBaselineDeadline: Date | null; renewalUnchangedAt: Date | null }>(`WITH due AS (
      SELECT "operationId" FROM e2b_compute_leases WHERE "renewalReviewAt"<=clock_timestamp()
      ORDER BY "renewalReviewAt" LIMIT 20 FOR UPDATE SKIP LOCKED
    ) UPDATE e2b_compute_leases l SET "renewalReviewAt"=clock_timestamp()+interval '30 seconds'
      FROM due WHERE l."operationId"=due."operationId"
      RETURNING l."operationId",l."ownerId",l."activeChunkIndex",l."sandboxId",l."providerScope",
        l."renewalDispatchId",l."renewalBaselineDeadline",l."renewalUnchangedAt"`)
  for (const row of rows) {
    const { ownerId, operationId, activeChunkIndex: index, renewalDispatchId } = row
    if (!renewalDispatchId) {
      await refundUnusedRenewal(ownerId, operationId, index)
      continue
    }
    try {
      const account = await e2bResourceAccount(ownerId, 'sandbox', row.sandboxId)
      if (account.scope !== row.providerScope) continue
      const observed = await Sandbox.getInfo(row.sandboxId, {
        apiKey: account.apiKey, requestTimeoutMs: E2B_TIMEOUT_REQUEST_BUDGET_MS, retries: 0,
      })
      if (observed.sandboxId !== row.sandboxId || !Number.isFinite(observed.endAt.getTime())) continue
      if (!row.renewalBaselineDeadline) continue
      if (observed.endAt.getTime() !== row.renewalBaselineDeadline.getTime()) {
        await useE2BKeepAlivePayment(pool, ownerId, { operationId, index }, true)
      } else if (observed.state !== 'running' && observed.state !== 'paused') {
        continue
      } else if (row.renewalUnchangedAt) {
        await refundUnusedRenewal(ownerId, operationId, index, renewalDispatchId)
      } else {
        await pool.query(`UPDATE e2b_compute_leases SET "renewalUnchangedAt"=clock_timestamp()
          WHERE "operationId"=$1 AND "ownerId"=$2 AND "activeChunkIndex"=$3 AND "renewalDispatchId"=$4`,
        [operationId, ownerId, index, renewalDispatchId])
      }
    } catch { /* A missing or unavailable read does not prove that a renewal did not run. */ }
  }
}

export async function e2bCreationTimeout(ownerId: string, providerScope: string, operationId: string, templateId: string,
  target: Target, requestedMs: number, verifiedSnapshot?: E2BComputeSpec): Promise<number> {
  if (!isCloudEdition()) return requestedMs
  const price = verifiedSnapshot ?? e2bTemplatePricing(templateId)
  if (!price) throw new E2BKeyError('e2b_template_unavailable', 'Verified E2B compute tier required')
  const { rows: [lease] } = await pool.query<Lease>(`INSERT INTO e2b_compute_leases AS l
    ("operationId","workspaceId","ownerId","providerScope","templateId",size,"hourlyMicroUsd","pricingVersion","cpuCount","memoryMB") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT("operationId") DO UPDATE SET "templateId"=l."templateId" WHERE
      (l."workspaceId",l."ownerId",l."providerScope",l."templateId",l.size,l."cpuCount",l."memoryMB")=
      (EXCLUDED."workspaceId",EXCLUDED."ownerId",EXCLUDED."providerScope",EXCLUDED."templateId",EXCLUDED.size,EXCLUDED."cpuCount",EXCLUDED."memoryMB")
    RETURNING l.*`, [operationId, target.workspaceId, ownerId, providerScope, templateId, price.size, price.hourlyMicroUsd, price.pricingVersion, price.cpuCount, price.memoryMB])
  if (!lease) throw unavailable()
  await paidTimeout(lease, target, requestedMs, true, true)
  // E2B fingerprints the entire create body. A settled first interval funds at
  // most five provider minutes, and retry submits exactly the same duration.
  return MACHINE_CHUNK_MS
}

export async function recordE2BComputeSandbox(ownerId: string, operationId: string, sandboxId: string, startedAt?: Date) {
  if (!isCloudEdition()) return
  const result = await pool.query(`UPDATE e2b_compute_leases SET "sandboxId"=$3,"creationMissingAt"=NULL,
    "paidUntil"=CASE WHEN "sandboxId" IS NULL AND "chunkIndex"=0 AND $4::timestamptz<=now()
      THEN greatest("paidUntil",$4::timestamptz+$5::int*interval '1 millisecond') ELSE "paidUntil" END
    WHERE "operationId"=$1
    AND "ownerId"=$2 AND "paidUntil" IS NOT NULL AND ("sandboxId" IS NULL OR "sandboxId"=$3)`, [operationId, ownerId, sandboxId, startedAt ?? null, MACHINE_CHUNK_MS])
  if (result.rowCount !== 1) throw unavailable()
}

/** Verify the actual geometry before exposing the SDK handle to any task. */
async function e2bAllocationMatches(ownerId: string, operationId: string, info: Pick<E2BComputeSpec, 'cpuCount' | 'memoryMB'>) {
  const { rows: [expected] } = await pool.query<Pick<E2BComputeSpec, 'cpuCount' | 'memoryMB'>>(
    `SELECT "cpuCount","memoryMB" FROM e2b_compute_leases WHERE "operationId"=$1 AND "ownerId"=$2 AND "paidUntil" IS NOT NULL`,
    [operationId, ownerId])
  if (!expected) throw unavailable()
  return expected.cpuCount === info.cpuCount && expected.memoryMB === info.memoryMB
}

/** A terminal provider refusal or a killed, unexposed mismatch used no task compute. */
export async function voidUnallocatedE2BCompute(ownerId: string, operationId: string, expiredOnly = false, firstOnly = false) {
  if (!isCloudEdition()) return
  await pool.query(`WITH refused AS (
      UPDATE e2b_compute_leases SET "paidUntil"=NULL WHERE "operationId"=$1 AND "ownerId"=$2
        AND "sandboxId" IS NULL AND "chunkIndex"=0 AND "paidUntil" IS NOT NULL
        AND (NOT $4::boolean OR "paidUntil"<=now()) AND (NOT $5::boolean OR "creationAttempts"=1)
      RETURNING "workspaceId"
    ) UPDATE hosted_usage u SET state='failed',"costMicroUsd"=0,"purchasedMicroUsd"=0,"planMicroUsd"=0,"planAllocations"='{}'
    FROM refused WHERE u.id=$3 AND u."usageWorkspaceId"=refused."workspaceId" AND u."executionOwnerId"=$2 AND u.state='settled'`,
  [operationId, ownerId, `machine:e2b:${operationId}:0`, expiredOnly, firstOnly])
}

export async function e2bInitialAllocationNeedsRecovery(ownerId: string, operationId: string) {
  if (!isCloudEdition()) return false
  const result = await pool.query(`SELECT 1 FROM e2b_compute_leases WHERE "operationId"=$1 AND "ownerId"=$2
    AND ("sandboxId" IS NOT NULL OR ("chunkIndex"=0 AND "paidUntil"<=now())
      OR ("chunkIndex"=-1 AND coalesce("fundingOpenedAt","pendingAt")<=now()-interval '5 minutes'
        AND EXISTS (SELECT 1 FROM hosted_usage u WHERE u.id='machine:e2b:'||"operationId"||':0' AND u.state='settled')))`, [operationId, ownerId])
  return result.rowCount === 1
}

/** A crashed settlement never reached provider admission. Reclaim only
 * after its provisioning window, racing the normal activation on the same row. */
export async function releaseInterruptedE2BCreation(ownerId: string, operationId: string) {
  if (!isCloudEdition()) return false
  const id = `machine:e2b:${operationId}:0`
  const result = await pool.query(`WITH interrupted AS (
      UPDATE e2b_compute_leases l SET "chunkIndex"=0,"pendingAt"=NULL,"pendingRunId"=NULL,"fundingOpenedAt"=NULL
      WHERE l."operationId"=$1 AND l."ownerId"=$2 AND l."sandboxId" IS NULL AND l."chunkIndex"=-1
      AND l."paidUntil" IS NULL AND l."creationAttempts"=0 AND coalesce(l."fundingOpenedAt",l."pendingAt")<=now()-interval '5 minutes'
      AND EXISTS (SELECT 1 FROM hosted_usage u WHERE u.id=$3 AND u."executionOwnerId"=$2
        AND u."usageWorkspaceId"=l."workspaceId" AND u.state='settled')
      RETURNING l."workspaceId"
    ) UPDATE hosted_usage u SET state='failed',"costMicroUsd"=0,"purchasedMicroUsd"=0,"planMicroUsd"=0,"planAllocations"='{}'
    FROM interrupted WHERE u.id=$3 AND u."executionOwnerId"=$2 AND u."usageWorkspaceId"=interrupted."workspaceId"
      AND u.state='settled'`, [operationId, ownerId, id])
  return result.rowCount === 1
}

export async function e2bCreationRecoveryAt(ownerId: string, operationId: string): Promise<number | undefined> {
  if (!isCloudEdition()) return
  const result = await pool.query<{ recoveryAt: Date | null }>(`SELECT coalesce(l."paidUntil",CASE WHEN EXISTS (SELECT 1 FROM hosted_usage u
      WHERE u.id='machine:e2b:'||l."operationId"||':0' AND u.state='settled')
      THEN coalesce(l."fundingOpenedAt",l."pendingAt")+interval '5 minutes' END) AS "recoveryAt"
    FROM e2b_compute_leases l WHERE "operationId"=$1 AND "ownerId"=$2 AND "sandboxId" IS NULL`, [operationId, ownerId])
  return result.rows[0]?.recoveryAt?.getTime()
}

export async function e2bSnapshotFallbackSafe(query: Pick<Pool, 'query'>, ownerId: string, operationId: string) {
  if (!isCloudEdition()) return true
  const result = await query.query(`SELECT 1 FROM e2b_compute_leases WHERE "operationId"=$1 AND "ownerId"=$2
    AND ("paidUntil" IS NOT NULL OR "sandboxId" IS NOT NULL OR "pendingAt" IS NOT NULL
      OR EXISTS (SELECT 1 FROM hosted_usage u WHERE u.id='machine:e2b:'||"operationId"||':0' AND u.state='settled'))`, [operationId, ownerId])
  return !result.rowCount
}

/** Require two exact empty provider reads after the initial interval elapsed. */
export async function observeMissingE2BAllocation(ownerId: string, operationId: string) {
  const { rows: [row] } = await pool.query<{ confirmed: boolean }>(`UPDATE e2b_compute_leases
    SET "creationMissingAt"=coalesce("creationMissingAt",now()) WHERE "operationId"=$1 AND "ownerId"=$2
      AND "paidUntil"<=now()
    RETURNING "creationMissingAt"<=now()-interval '30 seconds' AS confirmed`, [operationId, ownerId])
  if (row?.confirmed) await voidUnallocatedE2BCompute(ownerId, operationId, true)
  return row?.confirmed === true
}

/** Only a confirmed-unused operation permits rotating its provider idempotency key. */
export async function e2bCanReplaceOperation(query: Pick<Pool, 'query'>, ownerId: string, operationId: string) {
  if (!isCloudEdition()) return false
  const existing = await query.query(`SELECT 1 FROM e2b_compute_leases WHERE "operationId"=$1 AND "ownerId"=$2
    AND (("sandboxId" IS NULL AND "chunkIndex"=0 AND "paidUntil" IS NULL)
      OR ("creationMissingAt"<=now()-interval '30 seconds' AND "paidUntil"<=now()))`, [operationId, ownerId])
  return existing.rowCount === 1
}

/** Before metering, Bot requests used a different create body and did not
 * identify the operation in provider metadata. Retire that exact, unmetered
 * key without attempting to adopt an unidentifiable sandbox. */
export async function canReplaceLegacyBotOperation(query: Pick<Pool, 'query'>, ownerId: string, operationId: string) {
  if (!isCloudEdition()) return false
  const result = await query.query(`SELECT 1 FROM e2b_resource_accounts a
    WHERE a.kind='operation' AND a.id=$1::uuid::text AND a."ownerId"=$2 AND a.scope<>'personal'
      AND NOT EXISTS (SELECT 1 FROM e2b_compute_leases l WHERE l."operationId"=$1::uuid)`, [operationId, ownerId])
  return result.rowCount === 1
}

function definitiveE2BRefusal(error: unknown) {
  const cause = error instanceof E2BKeyError && error.cause ? error.cause : error
  const status = cause && typeof cause === 'object' ? (cause as { status?: unknown; statusCode?: unknown }).status
    ?? (cause as { statusCode?: unknown }).statusCode : undefined
  return cause instanceof AuthenticationError || cause instanceof NotFoundError || cause instanceof SandboxNotFoundError
    || status === 400 || status === 401 || status === 403 || status === 404
}

/** Void only unambiguous invalid create requests. Lost responses keep the paid
 * operation so the existing provider reconciliation can safely look it up. */
export async function createPrepaidE2B<T>(ownerId: string, operationId: string, create: () => Promise<T>): Promise<T> {
  if (!isCloudEdition()) return create()
  const { rows: [attempt] } = await pool.query<{ creationAttempts: number }>(
    `UPDATE e2b_compute_leases SET "creationAttempts"="creationAttempts"+1 WHERE "operationId"=$1
      AND "ownerId"=$2 AND "paidUntil">now() RETURNING "creationAttempts"`, [operationId, ownerId])
  if (!attempt) throw new E2BKeyError('e2b_limit_reached', 'No settled interval authorizes E2B creation')
  try {
    return await create()
  } catch (error) {
    if (attempt.creationAttempts === 1 && definitiveE2BRefusal(error))
      await voidUnallocatedE2BCompute(ownerId, operationId, false, true)
    throw error
  }
}

export async function verifyE2BAllocation(ownerId: string, operationId: string, sandboxId: string,
  options: SandboxApiOpts, observed?: Pick<E2BComputeSpec, 'cpuCount' | 'memoryMB'> & { startedAt?: Date }) {
  if (!isCloudEdition()) return
  // An uncertain observation retains the prepayment and operation for reconciliation.
  const specs = observed ?? await Sandbox.getInfo(sandboxId, options)
  if (!await e2bAllocationMatches(ownerId, operationId, specs)) {
    await Sandbox.kill(sandboxId, options)
    await voidUnallocatedE2BCompute(ownerId, operationId)
    throw new E2BKeyError('e2b_template_unavailable', 'E2B allocation did not match its verified hardware')
  }
  const startedAt = specs.startedAt && Number.isFinite(specs.startedAt.getTime()) ? specs.startedAt : undefined
  await recordE2BComputeSandbox(ownerId, operationId, sandboxId, startedAt)
}

/** Historical create intents have no charge to verify. Their exact provider
 * listing and a recognised allocation permit pausing under the old scope. */
export async function isLegacyE2BThreadAllocation(ownerId: string, workspaceId: string, runId: string, operationId: string,
  scope: string, hardware: Pick<SandboxInfo, 'cpuCount' | 'memoryMB'>) {
  if (!isCloudEdition() || scope === 'personal' || !e2bPricingForHardware(hardware.cpuCount, hardware.memoryMB)) return false
  const result = await pool.query(`SELECT 1 FROM thread_machines m JOIN e2b_resource_accounts a
    ON a.kind='operation' AND a.id=m."operationId"::text AND a."ownerId"=m."ownerId" AND a.scope=$5
    WHERE m."runId"=$1 AND m."workspaceId"=$2 AND m."ownerId"=$3 AND m."operationId"=$4 AND m."sandboxId" IS NULL
      AND NOT EXISTS (SELECT 1 FROM e2b_compute_leases l WHERE l."operationId"=m."operationId")`, [runId, workspaceId, ownerId, operationId, scope])
  return result.rowCount === 1
}

/** Existing hosted sandboxes predate the compute ledger. Only a bound
 * installation resource with measured, recognized hardware can acquire one. */
async function adoptHostedE2BLease(ownerId: string, sandboxId: string, providerScope: string, info: SandboxInfo) {
  const specs = e2bPricingForHardware(info.cpuCount, info.memoryMB)
  if (!specs || providerScope === 'personal' || info.sandboxId !== sandboxId)
    throw new E2BKeyError('e2b_template_unavailable', 'Unverified E2B allocation geometry')
  const { rows: [placement, ambiguous] } = await pool.query<{ workspaceId: string }>(`SELECT "workspaceId" FROM cloud_machines
    WHERE "sandboxId"=$1 AND "ownerId"=$2
    UNION SELECT "workspaceId" FROM thread_machines WHERE "sandboxId"=$1 AND "ownerId"=$2 AND state<>'ended'`,
  [sandboxId, ownerId])
  if (!placement || ambiguous) throw unavailable()
  await pool.query(`INSERT INTO e2b_compute_leases
    ("operationId","workspaceId","ownerId","providerScope","templateId",size,"hourlyMicroUsd","pricingVersion","cpuCount","memoryMB","sandboxId")
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11 FROM e2b_resource_accounts
    WHERE kind='sandbox' AND id=$11 AND "ownerId"=$3 AND scope=$4
    ON CONFLICT ("sandboxId") DO NOTHING`, [randomUUID(), placement.workspaceId, ownerId, providerScope, info.templateId,
    specs.size, specs.hourlyMicroUsd, specs.pricingVersion, specs.cpuCount, specs.memoryMB, sandboxId])
}

type E2BObservation = { providerScope: string; inspect: () => Promise<SandboxInfo> }

async function e2bSandboxTimeout(ownerId: string, sandboxId: string, requestedMs: number, renew = true, observe?: E2BObservation, payment?: KeepAlivePayment): Promise<number> {
  if (!isCloudEdition()) return requestedMs
  const readLease = async () => (await pool.query<Lease & { runId: string | null }>(`SELECT l.*,
    (SELECT "runId" FROM thread_machines WHERE "ownerId"=l."ownerId" AND "workspaceId"=l."workspaceId"
      AND "sandboxId"=l."sandboxId" AND state<>'ended' ORDER BY "lastActiveAt" DESC LIMIT 1) AS "runId"
    FROM e2b_compute_leases l WHERE l."ownerId"=$1 AND l."sandboxId"=$2`, [ownerId, sandboxId])).rows[0]
  let lease = await readLease()
  let inspected = false
  if (!lease && renew && observe) {
    await adoptHostedE2BLease(ownerId, sandboxId, observe.providerScope, await observe.inspect())
    inspected = true
    lease = await readLease()
  }
  if (!lease || observe && lease.providerScope !== observe.providerScope) throw unavailable()
  return paidTimeout(lease, lease, requestedMs, renew, false, inspected ? undefined : observe?.inspect, payment)
}

export function readPaidE2BTimeout(ownerId: string, sandboxId: string, requestedMs: number) {
  return e2bSandboxTimeout(ownerId, sandboxId, requestedMs, false)
}

/** Shared accounting for every provider action that can extend a paid lease. */
export async function prepareE2BProviderTime(ownerId: string, sandboxId: string, requestedMs: number, observe: E2BObservation, renew = true) {
  const payment: KeepAlivePayment = {}
  const inspect = async () => {
    const info = await observe.inspect()
    payment.baselineDeadline = info.endAt
    return info
  }
  const paidMs = await e2bSandboxTimeout(ownerId, sandboxId, requestedMs, renew, { ...observe, inspect }, payment).catch((error: unknown) => {
    if (!renew && error instanceof E2BKeyError && error.code === 'e2b_limit_reached') return 0
    throw error
  })
  const deadline = Date.now() + paidMs
  return {
    begin: () => prepareE2BKeepAliveDispatch(ownerId, payment, inspect),
    async apply<T>(query: Pick<PoolClient, 'query'>, send: (timeoutMs: number) => Promise<T>): Promise<{ result: T; deadline: number } | null> {
      const gate = await lockE2BKeepAliveDispatch(query, ownerId, payment)
      const now = Date.now()
      if (!gate || gate.dispatchBefore <= now) return null
      const remaining = Math.floor((deadline - now) / 1_000) * 1_000
      if (remaining < 1) return null
      const result = await send(remaining)
      await useE2BKeepAlivePayment(query, ownerId, payment, true)
      return { result, deadline }
    },
    cancel: () => releaseE2BKeepAlivePayment(ownerId, payment),
  }
}

export async function withE2BProviderTime<T>(ownerId: string, sandboxId: string, requestedMs: number, observe: E2BObservation,
  send: (timeoutMs: number) => Promise<T>): Promise<T> {
  if (!isCloudEdition()) return send(requestedMs)
  const intent = await prepareE2BProviderTime(ownerId, sandboxId, requestedMs, observe)
  let sent = false
  try {
    await intent.begin()
    // The sweeper can skip this row while the SDK request is in flight. The
    // previously committed dispatch marker remains if this transaction fails.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const applied = await intent.apply(client, timeoutMs => {
        sent = true
        return send(timeoutMs)
      })
      if (!applied) throw new E2BKeyError('e2b_limit_reached', 'The paid compute interval is awaiting reconciliation')
      await client.query('COMMIT')
      return applied.result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    if (!sent || definitiveE2BRefusal(error)) await intent.cancel()
    throw error
  }
}

export async function recordE2BComputeSnapshot(ownerId: string, sandboxId: string, snapshotId: string) {
  if (!isCloudEdition()) return
  const result = await pool.query(`UPDATE e2b_resource_accounts a SET "computeTemplateId"=l."templateId",
    "computeCpuCount"=l."cpuCount","computeMemoryMB"=l."memoryMB"
    FROM e2b_compute_leases l WHERE a.kind='snapshot' AND a.id=$1 AND a."ownerId"=$2 AND l."ownerId"=$2
      AND l."sandboxId"=$3 AND a.scope=l."providerScope" AND (a."computeTemplateId" IS NULL OR (a."computeTemplateId",a."computeCpuCount",a."computeMemoryMB")
        IS NOT DISTINCT FROM (l."templateId",l."cpuCount",l."memoryMB"))`,
    [snapshotId,ownerId,sandboxId])
  if (result.rowCount !== 1) throw unavailable()
}

export async function e2bSnapshotCompute(ownerId: string, snapshotId: string, scope: string) {
  const { rows: [row] } = await pool.query<{ templateId: string | null; cpuCount: number | null; memoryMB: number | null }>(
    `SELECT "computeTemplateId" AS "templateId", "computeCpuCount" AS "cpuCount", "computeMemoryMB" AS "memoryMB"
      FROM e2b_resource_accounts WHERE kind='snapshot' AND id=$1 AND "ownerId"=$2 AND scope=$3`, [snapshotId,ownerId,scope])
  const price = row?.cpuCount && row.memoryMB ? e2bPricingForHardware(row.cpuCount, row.memoryMB) : null
  return row?.templateId && price ? { templateId: row.templateId, price } : null
}
