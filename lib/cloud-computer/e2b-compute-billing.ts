import 'server-only'
import { Sandbox, type SandboxApiOpts } from 'e2b'
import { pool } from '@/lib/db'
import { isCloudEdition } from '@/lib/edition'
import { E2BKeyError } from '@/lib/secrets/flag'
import { e2bTemplatePricing, type E2BComputeSpec } from './e2b-template-pricing'
import { fundE2BChunk } from './machine-billing'
import { MACHINE_CHUNK_MS } from './machine-pricing'

export const E2B_RENEW_LEAD_MS = 45_000
const unavailable = () => new E2BKeyError('e2b_unavailable', 'E2B compute billing identity unavailable')

type Lease = { operationId: string; ownerId: string; workspaceId: string; providerScope: string;
  templateId: string; size: string; hourlyMicroUsd: number; chunkIndex: number }
type Target = { workspaceId: string; runId: string | null }

async function paidTimeout(lease: Lease, target: Target, requestedMs: number, renew = true, creation = false): Promise<number> {
  const claim = renew ? (await pool.query<{ chunkIndex: number; pendingRunId: string | null }>(
    `UPDATE e2b_compute_leases SET "pendingAt"=coalesce("pendingAt",greatest(now(),"paidUntil")),
        "pendingRunId"=CASE WHEN "pendingAt" IS NULL THEN $2 ELSE "pendingRunId" END
      WHERE "operationId"=$1 AND ("paidUntil" IS NULL OR "paidUntil"<=now()+$3::int*interval '1 millisecond')
        AND (NOT $4::boolean OR "chunkIndex"=-1)
        AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE id=$2 AND "stopRequestedAt" IS NOT NULL)
      RETURNING "chunkIndex","pendingRunId"`, [lease.operationId, target.runId, E2B_RENEW_LEAD_MS, creation])).rows[0] : undefined
  if (claim) {
    const index = claim.chunkIndex + 1
    const funded = await fundE2BChunk({ ownerId: lease.ownerId, workspaceId: target.workspaceId, runId: claim.pendingRunId,
      operationId: lease.operationId, index, size: lease.size, hourlyMicroUsd: lease.hourlyMicroUsd })

    // Settlement precedes activation. A lost response reuses this exact chunk;
    // concurrent confirmations advance the paid deadline only once.
    if (funded) await pool.query(`UPDATE e2b_compute_leases SET "chunkIndex"=$2,"paidUntil"=greatest(now(),"paidUntil")+$3::int*interval '1 millisecond',
      "pendingAt"=NULL,"pendingRunId"=NULL WHERE "operationId"=$1 AND "chunkIndex"=$2-1`, [lease.operationId, index, MACHINE_CHUNK_MS])
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
  const result = await pool.query(`UPDATE e2b_compute_leases SET "sandboxId"=$3 WHERE "operationId"=$1
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
export async function voidUnallocatedE2BCompute(ownerId: string, operationId: string) {
  if (!isCloudEdition()) return
  await pool.query(`WITH refused AS (
      UPDATE e2b_compute_leases SET "paidUntil"=NULL WHERE "operationId"=$1 AND "ownerId"=$2
        AND "sandboxId" IS NULL AND "chunkIndex"=0 AND "paidUntil" IS NOT NULL
      RETURNING "workspaceId"
    ) UPDATE hosted_usage u SET state='failed',"costMicroUsd"=0,"purchasedMicroUsd"=0,"planMicroUsd"=0,"planAllocations"='{}'
    FROM refused WHERE u.id=$3 AND u."usageWorkspaceId"=refused."workspaceId" AND u."executionOwnerId"=$2 AND u.state='settled'`,
  [operationId, ownerId, `machine:e2b:${operationId}:0`])
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

export async function e2bSandboxTimeout(ownerId: string, sandboxId: string, requestedMs: number, renew = true): Promise<number> {
  if (!isCloudEdition()) return requestedMs
  const { rows: [lease] } = await pool.query<Lease & {runId: string | null}>(`SELECT l.*,
    (SELECT "runId" FROM thread_machines WHERE "ownerId"=l."ownerId" AND "workspaceId"=l."workspaceId"
      AND "sandboxId"=l."sandboxId" AND state<>'ended' ORDER BY "lastActiveAt" DESC LIMIT 1) AS "runId"
    FROM e2b_compute_leases l WHERE l."ownerId"=$1 AND l."sandboxId"=$2`,[ownerId,sandboxId])
  if (!lease) throw unavailable()
  return paidTimeout(lease, lease, requestedMs, renew)
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
  if (!row?.templateId) throw unavailable()
  return row.templateId
}
