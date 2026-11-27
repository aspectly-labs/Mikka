import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { isCloudEdition } from '@/lib/edition'
import { machineCommitted } from '@/lib/live/computer-state'

type Probe = (workspaceId: string, sandboxId: string) => Promise<'running' | 'sleeping'>

/**
 * Brings stale Bot computers (`cloud_machines`) back in line with E2B. A row
 * that has said running or waking for over an hour is checked: a sandbox E2B
 * no longer has becomes `sleeping` with no sandbox (the next wake creates a
 * new one), and a sandbox E2B paused becomes `sleeping`. Any other answer,
 * including an unusable key, leaves the row alone. Rows mid-provisioning are
 * skipped. Returns how many rows changed.
 */
export async function reconcileCloudMachines(pool: Pick<Pool, 'query'>, probe?: Probe, limit = 20) {
  const check = probe ?? (await import('./e2b-provider')).computerState
  const { sandboxGone } = await import('@/lib/cloud-computer/thread-machines')
  const { rows } = await pool.query<{ workspaceId: string; ownerId: string; sandboxId: string }>(`SELECT "workspaceId","ownerId","sandboxId" FROM cloud_machines
    WHERE state IN ('running','waking') AND "sandboxId" IS NOT NULL AND "lastActiveAt"<now()-interval '1 hour'
      AND ("provisionLeaseUntil" IS NULL OR "provisionLeaseUntil"<now())
    ORDER BY "lastActiveAt" LIMIT $1`, [limit])
  let changed = 0
  for (const row of rows) {
    let state: 'running' | 'sleeping' | 'gone'
    try { state = await check(row.workspaceId, row.sandboxId) } catch (error) {
      if (!sandboxGone(error)) continue
      state = 'gone'
    }
    if (state === 'running') continue
    // Recheck staleness and the lease so a wake that raced the probe wins.
    const updated = await pool.query(`UPDATE cloud_machines SET state='sleeping'${state === 'gone' ? ',"sandboxId"=NULL,"runtimeReady"=false,"operationId"=$4' : ''}
      WHERE "workspaceId"=$1 AND "ownerId"=$2 AND "sandboxId"=$3 AND state IN ('running','waking')
        AND "lastActiveAt"<now()-interval '1 hour'
        AND ("provisionLeaseUntil" IS NULL OR "provisionLeaseUntil"<now())`, [row.workspaceId, row.ownerId, row.sandboxId, ...(state === 'gone' ? [randomUUID()] : [])])
    changed += updated.rowCount ?? 0
    if (updated.rowCount) {
      if (!probe && isCloudEdition()) {
        const { settleE2BAwakeInterval } = await import('../cloud-computer/e2b-compute-billing')
        await settleE2BAwakeInterval(row.ownerId, row.sandboxId, undefined, undefined, { botWorkspaceId: row.workspaceId })
      }
      await machineCommitted(pool, row.ownerId, row.workspaceId)
    }
  }
  if (!probe && isCloudEdition()) {
    const { reconcileE2BKeepAlivePayments } = await import('../cloud-computer/e2b-compute-billing')
    await reconcileE2BKeepAlivePayments()
    await (await import('../cloud-computer/cloudflare-compute-billing')).reconcileCloudflareCompute(pool)
    changed += await recoverInitialCloudMachines(pool, limit)
  }
  return changed
}

async function recoverInitialCloudMachines(pool: Pick<Pool, 'query'>, limit: number) {
  const { reconcileInitialComputerAllocation } = await import('./e2b-provider')
  const { rows } = await pool.query<{ workspaceId: string; ownerId: string; operationId: string }>(`WITH due AS (
    SELECT m."workspaceId",m."ownerId",m."operationId" FROM cloud_machines m
    JOIN e2b_compute_leases l ON l."operationId"=m."operationId" AND l."ownerId"=m."ownerId"
    WHERE m."sandboxId" IS NULL AND m.state IN ('error','waking') AND (l."paidUntil"<=now() OR (l."chunkIndex"=-1 AND coalesce(l."fundingOpenedAt",l."pendingAt")<=now()-interval '5 minutes'
      AND EXISTS (SELECT 1 FROM hosted_usage u WHERE u.id='machine:e2b:'||l."operationId"||':0' AND u.state='settled')))
      AND m."lastActiveAt"+interval '30 seconds'<=now()
      AND (m."provisionLeaseUntil" IS NULL OR m."provisionLeaseUntil"<=now())
    ORDER BY l."paidUntil" LIMIT $1 FOR UPDATE OF m SKIP LOCKED
  ) UPDATE cloud_machines m SET "lastActiveAt"=now() FROM due
    WHERE m."workspaceId"=due."workspaceId" AND m."ownerId"=due."ownerId" AND m."operationId"=due."operationId"
    RETURNING m."workspaceId",m."ownerId",m."operationId"`, [limit])
  let recovered = 0
  for (const row of rows) {
    try {
      const allocation = await reconcileInitialComputerAllocation(row.workspaceId, row.ownerId, row.operationId)
      if (!allocation) continue
      const committed = await pool.query(`UPDATE cloud_machines SET "sandboxId"=$4,state='sleeping',
          "errorCode"=NULL,"runtimeReady"=false,"provisionLeaseId"=NULL,"provisionLeaseUntil"=NULL
        WHERE "workspaceId"=$1 AND "ownerId"=$2 AND "operationId"=$3 AND "sandboxId" IS NULL
          AND ("provisionLeaseUntil" IS NULL OR "provisionLeaseUntil"<=now())`,
      [row.workspaceId, row.ownerId, row.operationId, allocation.sandboxId])
      if (committed.rowCount) {
        recovered += committed.rowCount
        await machineCommitted(pool, row.ownerId, row.workspaceId)
      }
    } catch { /* A bounded next timer retries an uncertain provider observation. */ }
  }
  return recovered
}
