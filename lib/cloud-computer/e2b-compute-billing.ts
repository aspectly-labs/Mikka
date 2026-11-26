import 'server-only'
import { randomUUID } from 'node:crypto'
import { NotFoundError, Sandbox, SandboxNotFoundError, type SandboxApiOpts, type SandboxInfo } from 'e2b'
import type { Pool } from 'pg'
import { pool } from '@/lib/db'
import { isCloudEdition } from '@/lib/edition'
import { E2BKeyError } from '@/lib/secrets/flag'
import { e2bPricingForHardware, e2bTemplatePricing, type E2BComputeSpec } from './e2b-template-pricing'
import { fundE2BChunk } from './machine-billing'
import { MACHINE_CHUNK_MS } from './machine-pricing'

export const E2B_RENEW_LEAD_MS = 45_000
const unavailable = () => new E2BKeyError('e2b_unavailable', 'E2B compute billing identity unavailable')

type Lease = { operationId: string; ownerId: string; workspaceId: string; providerScope: string;
  templateId: string; size: string; hourlyMicroUsd: number; chunkIndex: number }
type Target = { workspaceId: string; runId: string | null }

async function paidTimeout(lease: Lease, target: Target, requestedMs: number, renew = true, creation = false, beforeRenew?: () => Promise<unknown>): Promise<number> {
  const claim = renew ? (await pool.query<{ chunkIndex: number; pendingRunId: string | null }>(
    `UPDATE e2b_compute_leases SET "pendingAt"=coalesce("pendingAt",greatest(now(),"paidUntil")),
        "pendingRunId"=CASE WHEN "pendingAt" IS NULL THEN $2 ELSE "pendingRunId" END
      WHERE "operationId"=$1 AND ("paidUntil" IS NULL OR "paidUntil"<=now()+$3::int*interval '1 millisecond')
        AND (NOT $4::boolean OR "chunkIndex"=-1)
        AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE id=$2 AND "stopRequestedAt" IS NOT NULL)
      RETURNING "chunkIndex","pendingRunId"`, [lease.operationId, target.runId, E2B_RENEW_LEAD_MS, creation])).rows[0] : undefined
  if (claim) {
    await beforeRenew?.()
    const index = claim.chunkIndex + 1
    const funded = await fundE2BChunk({ ownerId: lease.ownerId, workspaceId: target.workspaceId, runId: claim.pendingRunId,
      operationId: lease.operationId, index, size: lease.size, hourlyMicroUsd: lease.hourlyMicroUsd })

    // Settlement precedes activation. A lost response reuses this exact chunk;
    // concurrent confirmations advance the paid deadline only once.
    if (funded) await pool.query(`UPDATE e2b_compute_leases SET "chunkIndex"=$2,"paidUntil"=greatest(now(),"paidUntil")+$3::int*interval '1 millisecond',
      "pendingAt"=NULL,"pendingRunId"=NULL WHERE "operationId"=$1 AND "chunkIndex"=$2-1`, [lease.operationId, index, MACHINE_CHUNK_MS])
    else await pool.query(`UPDATE e2b_compute_leases SET "pendingAt"=NULL,"pendingRunId"=NULL
      WHERE "operationId"=$1 AND "chunkIndex"=$2-1 AND "pendingRunId" IS NOT DISTINCT FROM $3::uuid`,
    [lease.operationId, index, claim.pendingRunId])
  }
  const { rows: [row] } = await pool.query<{ remainingMs: number }>(
    `SELECT floor(extract(epoch FROM ("paidUntil"-clock_timestamp()))*1000)::int AS "remainingMs"
      FROM e2b_compute_leases WHERE "operationId"=$1`, [lease.operationId])
  // E2B rounds up to seconds. Use whole seconds and allow for provider request latency.
  const seconds = Math.floor((Math.min(requestedMs, row?.remainingMs ?? 0, MACHINE_CHUNK_MS + E2B_RENEW_LEAD_MS) - 1_000) / 1_000)
  if (seconds < 1) throw new E2BKeyError('e2b_limit_reached', 'Mikka credits are insufficient for five minutes of compute')
  return seconds * 1_000
}

export async function e2bCreationTimeout(ownerId: string, providerScope: string, operationId: string, templateId: string,
  target: Target, requestedMs: number): Promise<number> {
  if (!isCloudEdition()) return requestedMs
  const price = e2bTemplatePricing(templateId)
  if (!price) throw new E2BKeyError('e2b_template_unavailable', 'Verified E2B compute tier required')
  const { rows: [lease] } = await pool.query<Lease>(`INSERT INTO e2b_compute_leases AS l
    ("operationId","workspaceId","ownerId","providerScope","templateId",size,"hourlyMicroUsd","cpuCount","memoryMB") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT("operationId") DO UPDATE SET "templateId"=l."templateId" WHERE
      (l."workspaceId",l."ownerId",l."providerScope",l."templateId",l.size,l."hourlyMicroUsd",l."cpuCount",l."memoryMB")=
      (EXCLUDED."workspaceId",EXCLUDED."ownerId",EXCLUDED."providerScope",EXCLUDED."templateId",EXCLUDED.size,EXCLUDED."hourlyMicroUsd",EXCLUDED."cpuCount",EXCLUDED."memoryMB")
    RETURNING l.*`, [operationId, target.workspaceId, ownerId, providerScope, templateId, price.size, price.hourlyMicroUsd, price.cpuCount, price.memoryMB])
  if (!lease) throw unavailable()
  return paidTimeout(lease, target, requestedMs, true, true)
}

export async function recordE2BComputeSandbox(ownerId: string, operationId: string, sandboxId: string) {
  if (!isCloudEdition()) return
  const result = await pool.query(`UPDATE e2b_compute_leases SET "sandboxId"=$3,"creationMissingAt"=NULL WHERE "operationId"=$1
    AND "ownerId"=$2 AND "paidUntil" IS NOT NULL AND ("sandboxId" IS NULL OR "sandboxId"=$3)`, [operationId,ownerId,sandboxId])
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
export async function voidUnallocatedE2BCompute(ownerId: string, operationId: string, expiredOnly = false) {
  if (!isCloudEdition()) return
  await pool.query(`WITH refused AS (
      UPDATE e2b_compute_leases SET "paidUntil"=NULL WHERE "operationId"=$1 AND "ownerId"=$2
        AND "sandboxId" IS NULL AND "chunkIndex"=0 AND "paidUntil" IS NOT NULL
        AND (NOT $4::boolean OR "paidUntil"<=now())
      RETURNING "workspaceId"
    ) UPDATE hosted_usage u SET state='failed',"costMicroUsd"=0,"purchasedMicroUsd"=0,"planMicroUsd"=0,"planAllocations"='{}'
    FROM refused WHERE u.id=$3 AND u."usageWorkspaceId"=refused."workspaceId" AND u."executionOwnerId"=$2 AND u.state='settled'`,
  [operationId, ownerId, `machine:e2b:${operationId}:0`, expiredOnly])
}

export async function e2bInitialAllocationNeedsRecovery(ownerId: string, operationId: string) {
  if (!isCloudEdition()) return false
  const result = await pool.query(`SELECT 1 FROM e2b_compute_leases WHERE "operationId"=$1 AND "ownerId"=$2
    AND ("sandboxId" IS NOT NULL OR ("chunkIndex"=0 AND "paidUntil"<=now()))`, [operationId, ownerId])
  return result.rowCount === 1
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

/** Void only unambiguous invalid create requests. Lost responses keep the paid
 * operation so the existing provider reconciliation can safely look it up. */
export async function createPrepaidE2B<T>(ownerId: string, operationId: string, create: () => Promise<T>): Promise<T> {
  try {
    return await create()
  } catch (error) {
    const cause = error instanceof E2BKeyError && error.cause ? error.cause : error
    const status = cause && typeof cause === 'object' ? (cause as { status?: unknown; statusCode?: unknown }).status
      ?? (cause as { statusCode?: unknown }).statusCode : undefined
    if (cause instanceof NotFoundError || cause instanceof SandboxNotFoundError || status === 400 || status === 404 || status === 422)
      await voidUnallocatedE2BCompute(ownerId, operationId)
    throw error
  }
}

export async function verifyE2BAllocation(ownerId: string, operationId: string, sandboxId: string,
  options: SandboxApiOpts, observed?: Pick<E2BComputeSpec, 'cpuCount' | 'memoryMB'>) {
  if (!isCloudEdition()) return
  // An uncertain observation retains the prepayment and operation for reconciliation.
  const specs = observed ?? await Sandbox.getInfo(sandboxId, options)
  if (!await e2bAllocationMatches(ownerId, operationId, specs)) {
    await Sandbox.kill(sandboxId, options)
    await voidUnallocatedE2BCompute(ownerId, operationId)
    throw new E2BKeyError('e2b_template_unavailable', 'E2B allocation did not match its verified hardware')
  }
  await recordE2BComputeSandbox(ownerId, operationId, sandboxId)
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
    ("operationId","workspaceId","ownerId","providerScope","templateId",size,"hourlyMicroUsd","cpuCount","memoryMB","sandboxId")
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10 FROM e2b_resource_accounts
    WHERE kind='sandbox' AND id=$10 AND "ownerId"=$3 AND scope=$4
    ON CONFLICT ("sandboxId") DO NOTHING`, [randomUUID(), placement.workspaceId, ownerId, providerScope, info.templateId,
    specs.size, specs.hourlyMicroUsd, specs.cpuCount, specs.memoryMB, sandboxId])
}

type E2BObservation = { providerScope: string; inspect: () => Promise<SandboxInfo> }

export async function e2bSandboxTimeout(ownerId: string, sandboxId: string, requestedMs: number, renew = true, observe?: E2BObservation): Promise<number> {
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
  return paidTimeout(lease, lease, requestedMs, renew, false, inspected ? undefined : observe?.inspect)
}

export async function recordE2BComputeSnapshot(ownerId: string, sandboxId: string, snapshotId: string) {
  if (!isCloudEdition()) return
  const result = await pool.query(`UPDATE e2b_resource_accounts a SET "computeTemplateId"=l."templateId"
    FROM e2b_compute_leases l WHERE a.kind='snapshot' AND a.id=$1 AND a."ownerId"=$2 AND l."ownerId"=$2
      AND l."sandboxId"=$3 AND a.scope=l."providerScope" AND (a."computeTemplateId" IS NULL OR a."computeTemplateId"=l."templateId")`,
    [snapshotId,ownerId,sandboxId])
  if (result.rowCount !== 1) throw unavailable()
}

export async function e2bSnapshotComputeTemplate(ownerId: string, snapshotId: string) {
  if (!isCloudEdition()) return ''
  const { rows: [row] } = await pool.query<{templateId: string}>(
    `SELECT "computeTemplateId" AS "templateId" FROM e2b_resource_accounts WHERE kind='snapshot' AND id=$1 AND "ownerId"=$2`,
    [snapshotId,ownerId])
  return row?.templateId ?? null
}
