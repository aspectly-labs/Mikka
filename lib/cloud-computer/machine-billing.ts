import 'server-only'
import { PaidResourceError } from '@/lib/abuse/policy'
import { MACHINE_CHUNK_MS, machineChunkMicroUsd, type MachineSize } from './machine-pricing'
import { readRunChain } from '@/lib/run-chain'

const FUNDING_REFUSALS = new Set(['verification_required', 'free_allowance_used', 'points_exhausted', 'usage_budget_exhausted', 'billing_authorization_revoked', 'platform_paused', 'billing_scope_missing', 'billing_owner_missing'])

export interface MachineChunk {
  ownerId: string
  workspaceId: string
  runId: string
  operationId: string
  /** 0 for the chunk paid before the machine opens, then 1, 2, … */
  index: number
  size: MachineSize
}

export const machineChunkId = (chunk: Pick<MachineChunk, 'runId' | 'operationId' | 'index'>) =>
  `machine:${chunk.runId}:${chunk.operationId}:${chunk.index}`

export interface MachineBillingDependencies {
  /** The settled state of a chunk already charged, if any. */
  state(id: string): Promise<string | null>
  /** Hold the chunk's cost from Mikka 额度 (the workspace's, else a member's shared credits) and settle it at once. */
  charge(chunk: MachineChunk, id: string, cost: number): Promise<void>
}

/**
 * Prepays one chunk of machine time. True when it is paid (now or already),
 * false when nothing can pay for it; other failures are thrown with their cause.
 * Idempotent per (run, operation, index): a retried renewal never charges twice.
 */
export async function fundMachineChunk(chunk: MachineChunk, dependencies: MachineBillingDependencies = runtime): Promise<boolean> {
  const id = machineChunkId(chunk)
  const prior = await dependencies.state(id)
  if (prior === 'settled') return true
  try {
    await dependencies.charge(chunk, id, machineChunkMicroUsd(chunk.size))
    return true
  } catch (error) {
    if (error instanceof PaidResourceError && FUNDING_REFUSALS.has(error.code)) return false
    if (error instanceof PaidResourceError && error.code === 'usage_in_progress') return (await dependencies.state(id)) === 'settled'
    throw new Error('machine_chunk_charge_failed', { cause: error })
  }
}

const runtime: MachineBillingDependencies = {
  async state(id) {
    const { pool } = await import('@/lib/db')
    const { rows: [row] } = await pool.query<{ state: string }>('SELECT state FROM hosted_usage WHERE id=$1', [id])
    return row?.state ?? null
  },
  async charge(chunk, id, cost) {
    const [{ hostedUsage }, { withSharedCredits }, { hostedBillingScope }] = await Promise.all([
      import('@/lib/abuse/runtime'), import('@/lib/credit-shares'), import('@/lib/abuse/context'),
    ])
    const label = `machine/cloudflare-${chunk.size}`
    await hostedBillingScope.run({ workspaceId: chunk.workspaceId, ownerId: chunk.ownerId, runId: chunk.runId, actorId: chunk.ownerId },
      () => withSharedCredits(chunk.workspaceId, payer => hostedUsage.reserve(payer, label, id, process.env, cost)))
    // Prepaid: the chunk is charged in full when it starts, as Capy holds machine time ahead.
    await hostedUsage.settle(id, cost)
  },
}

/** Five minutes on a verified E2B SKU. Its receipt namespace cannot consume
 * a Cloudflare reservation for the same machine or run. */
export async function fundE2BChunk(chunk: { ownerId: string; workspaceId: string; runId: string | null;
  operationId: string; index: number; size: string; hourlyMicroUsd: number }): Promise<boolean> {
  const [{ pool }, { hostedUsage }, { withSharedCredits }, { hostedBillingScope }] = await Promise.all([
    import('@/lib/db'), import('@/lib/abuse/runtime'), import('@/lib/credit-shares'), import('@/lib/abuse/context'),
  ])
  if (!hostedUsage.metered) return false
  const id = `machine:e2b:${chunk.operationId}:${chunk.index}`
  const cost = Math.ceil(chunk.hourlyMicroUsd * MACHINE_CHUNK_MS / 3_600_000)
  const model = `machine/e2b-${chunk.size}`
  async function receipt() {
    const { rows: [row] } = await pool.query<{state: string}>(`SELECT CASE WHEN state='settled' AND (coalesce("unpaidMicroUsd",0)>0 OR "costMicroUsd" IS DISTINCT FROM $3)
      THEN 'unfunded' ELSE state END AS state FROM hosted_usage WHERE id=$1 AND model=$2
      AND "holdMicroUsd"=$3 AND "usageWorkspaceId"=$4 AND "executionOwnerId"=$5
      AND "usageRunId" IS NOT DISTINCT FROM $6::uuid`, [id,model,cost,chunk.workspaceId,chunk.ownerId,chunk.runId])
    return row?.state
  }
  try {
    const prior = await receipt()
    if (prior === 'settled') return true
    if (prior) return false
    const run = chunk.runId ? (await pool.query<{ projectId: string | null }>(
      `SELECT r."agentDefinition"#>>'{projectExecution,projectId}' AS "projectId"
      FROM agent_runs r WHERE r.id=$1 AND r."userId"=$2 AND r."workspaceId"=$3 AND r."stopRequestedAt" IS NULL`,
      [chunk.runId, chunk.ownerId, chunk.workspaceId])).rows[0] : null
    if (chunk.runId && !run) return false
    const threadId = chunk.runId ? (await readRunChain(pool, chunk.ownerId, chunk.runId))?.rootRunId : null
    if (chunk.runId && !threadId) return false
    try {
      await hostedBillingScope.run({ workspaceId: chunk.workspaceId, ownerId: chunk.ownerId,
        runId: chunk.runId, actorId: chunk.ownerId, billingSource: 'credits', projectId: run?.projectId ?? null,
        threadId, attributionComplete: true },
      () => withSharedCredits(chunk.workspaceId, payer => hostedUsage.reserve(payer, model, id, process.env, cost, true)))
    } catch (error) {
      if (!(error instanceof PaidResourceError) || error.code !== 'usage_in_progress') throw error
    }
    return await receipt() === 'settled'
  } catch (error) {
    if (error instanceof PaidResourceError && FUNDING_REFUSALS.has(error.code)) return false
    throw error
  }
}
