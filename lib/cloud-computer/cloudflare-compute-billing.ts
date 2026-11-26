import 'server-only'
import { z } from 'zod'
import type { Pool } from 'pg'
import { PaidResourceError } from '../abuse/policy'
import { machineChunkId, type CloudflareMachineChunk } from './machine-billing'
import { MACHINE_CHUNK_MS, machineLedgerLabel, machineListUsageMicroUsd, machineSkuGeometry, machineSkuListPrice } from './machine-pricing'
import { releaseGrant } from './sponsored-task'
import type { TaskMachineGrant } from '../eve/cloudflare-task-connection'
import { readCloudflareComputeMeter } from '../eve/cloudflare-task-bridge'

const measurement = z.object({
  index: z.number().int().nonnegative(),
  provisionedMs: z.number().int().nonnegative(),
  activeVcpuMs: z.number().int().nonnegative(),
  observedAt: z.number().int().nonnegative(),
})
const rate = z.object({
  version: z.string(),
  effectiveFrom: z.string(),
  effectiveUntil: z.string().nullable(),
  minimumPrepaidSeconds: z.number().int(),
  basis: z.literal('active_cpu'),
  fixedHourlyMicroUsd: z.number().int().positive(),
  activeVcpuHourlyMicroUsd: z.number().int().positive(),
})

/** A hold is authorization up to the requested SKU capacity. Actual charges
 * are settled only after the isolated provider returns measured usage. */
export async function holdCloudflareCompute(pool: Pick<Pool, 'query'>, chunk: CloudflareMachineChunk) {
  const price = machineSkuListPrice(chunk)
  if (price?.basis !== 'active_cpu') return false
  const hold = machineListUsageMicroUsd(price, MACHINE_CHUNK_MS, machineSkuGeometry(chunk).vcpu * MACHINE_CHUNK_MS)
  if (!hold) return false
  const id = machineChunkId(chunk), label = machineLedgerLabel(chunk)
  const read = async () => (await pool.query<{ state: string; model: string; outcome: string | null }>(`
    SELECT state,model,"machineCompute"->>'outcome' AS outcome FROM hosted_usage WHERE id=$1 AND "usageWorkspaceId"=$2 AND "executionOwnerId"=$3
      AND "machineCompute"->>'source'='cloudflare_cgroup_list'`, [id, chunk.workspaceId, chunk.ownerId])).rows[0]
  const prior = await read()
  if (prior) return prior.model === label && prior.outcome === null && ['unknown', 'settled'].includes(prior.state)
  const [{ hostedUsage }, { hostedBillingScope }, { withSharedCredits }] = await Promise.all([
    import('../abuse/runtime'), import('../abuse/context'), import('../credit-shares'),
  ])
  if (!hostedUsage.metered) return false
  const grant = await releaseGrant(pool, { userId: chunk.ownerId, workspaceId: chunk.workspaceId }, chunk.runId, chunk.operationId)
  try {
    await hostedBillingScope.run({ workspaceId: chunk.workspaceId, ownerId: chunk.ownerId,
      actorId: chunk.ownerId, runId: chunk.runId, billingSource: 'credits', attributionComplete: true },
    () => withSharedCredits(chunk.workspaceId, payer => hostedUsage.reserve(payer, label, id, process.env, hold, {
      machineMeter: { source: 'cloudflare_cgroup_list', provider: 'cloudflare', operationId: chunk.operationId, index: chunk.index, price, grant },
    })))
  } catch (error) {
    if (!(error instanceof PaidResourceError)) throw error
    if (error.code !== 'usage_in_progress') return false
  }
  const held = await read()
  return held?.model === label && held.outcome === null && ['unknown', 'settled'].includes(held.state)
}

type MeterReceipt = {
  id: string
  state: string
  machineCompute: { price: unknown; grant: TaskMachineGrant; index: number }
  hold: number
}

async function settleCloudflareReceipt(receipt: MeterReceipt, rollover: boolean) {
  const { machineCompute: { grant, index } } = receipt
  if (receipt.state === 'settled') {
    const recorded = measurement.safeParse(receipt.machineCompute)
    return recorded.success ? recorded.data : null
  }
  if (receipt.state !== 'unknown') return null
  const { hostedUsage } = await import('../abuse/runtime')
  if (await hostedUsage.expireMeasuredMachine(receipt.id)) return null
  const price = rate.parse(receipt.machineCompute.price)
  const raw = await readCloudflareComputeMeter(grant, index, rollover)
  if (raw && typeof raw === 'object' && 'notStarted' in raw && raw.notStarted === true) {
    await hostedUsage.settleMeasuredMachine(receipt.id, 0, { outcome: 'not_started' })
    return null
  }
  if (raw && typeof raw === 'object' && 'measurementUnavailable' in raw && raw.measurementUnavailable === true) {
    await hostedUsage.settleMeasuredMachine(receipt.id, 0, { outcome: 'measurement_unavailable' })
    return null
  }
  const sample = measurement.safeParse(raw)
  if (!sample.success || sample.data.index !== index) return null
  const measuredCost = machineListUsageMicroUsd(price, sample.data.provisionedMs, sample.data.activeVcpuMs)
  if (measuredCost === null) return null
  // The platform absorbs any provider work past the authorized hold.
  await hostedUsage.settleMeasuredMachine(receipt.id, Math.min(receipt.hold, measuredCost), { ...sample.data, measuredCost })
  return sample.data
}

export async function settleCloudflareCompute(pool: Pick<Pool, 'query'>, chunk: CloudflareMachineChunk, rollover: boolean) {
  const { rows: [receipt] } = await pool.query<MeterReceipt>(`
    SELECT id,state,"machineCompute","holdMicroUsd"::int AS hold FROM hosted_usage
    WHERE id=$1 AND model=$2 AND "usageWorkspaceId"=$3 AND "executionOwnerId"=$4
      AND "machineCompute"->>'source'='cloudflare_cgroup_list'`,
  [machineChunkId(chunk), machineLedgerLabel(chunk), chunk.workspaceId, chunk.ownerId])
  return receipt ? settleCloudflareReceipt(receipt, rollover) : null
}

/** Retry using the original grant after a run moves operations. Expired holds
 * close without a charge if no provider receipt arrived within the review window. */
export async function reconcileCloudflareCompute(pool: Pick<Pool, 'query'>) {
  const { rows } = await pool.query<MeterReceipt>(`WITH due AS (
    SELECT id FROM hosted_usage WHERE "machineComputeReviewAt"<=clock_timestamp()
      ORDER BY "machineComputeReviewAt" LIMIT 20 FOR UPDATE SKIP LOCKED
  ) UPDATE hosted_usage u SET "machineComputeReviewAt"=clock_timestamp()+interval '30 seconds'
    FROM due WHERE u.id=due.id RETURNING u.id,u.state,u."machineCompute",u."holdMicroUsd"::int AS hold`)
  for (const receipt of rows) await settleCloudflareReceipt(receipt, false).catch(() => undefined)
}
