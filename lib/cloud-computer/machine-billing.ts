import 'server-only'
import { PaidResourceError } from '@/lib/abuse/policy'
import { machineChunkMicroUsd, machineLedgerLabel, prepaidMachineMicroUsd, type MachineSize, type E2BMachineSize } from './machine-pricing'
import { readRunChain } from '@/lib/run-chain'
import { runtimeEnv } from '@/lib/env/server'

const FUNDING_REFUSALS = new Set(['verification_required', 'free_allowance_used', 'points_exhausted', 'usage_budget_exhausted', 'billing_authorization_revoked', 'platform_paused', 'billing_scope_missing', 'billing_owner_missing'])

interface MachineChunkIdentity {
  ownerId: string
  workspaceId: string
  operationId: string
  /** 0 for the chunk paid before the machine opens, then 1, 2, … */
  index: number
}

export type CloudflareMachineChunk = MachineChunkIdentity & { provider: 'cloudflare'; size: MachineSize; runId: string }
export type E2BMachineChunk = MachineChunkIdentity & { provider: 'e2b'; size: E2BMachineSize; runId: string | null;
  /** From the verified allocation's frozen list price. */
  hourlyMicroUsd: number
}
export type MachineChunk = CloudflareMachineChunk | E2BMachineChunk

/** Existing provider namespaces and operation identities must survive upgrades. */
export const machineChunkId = (chunk: Pick<MachineChunk, 'provider' | 'runId' | 'operationId' | 'index'>) =>
  chunk.provider === 'e2b' ? `machine:e2b:${chunk.operationId}:${chunk.index}`
    : `machine:${chunk.runId}:${chunk.operationId}:${chunk.index}`

export interface MachineBillingDependencies {
  /** The settled state of a chunk already charged, if any. */
  state(id: string, chunk: CloudflareMachineChunk): Promise<string | null>
  /** Hold the chunk's cost from Mikka 额度 (the workspace's, else a member's shared credits) and settle it at once. */
  charge(chunk: CloudflareMachineChunk, id: string, cost: number): Promise<void>
}

/**
 * Prepays one chunk of machine time. True when it is paid (now or already),
 * false when nothing can pay for it; other failures are thrown with their cause.
 * Idempotent per (run, operation, index): a retried renewal never charges twice.
 */
export async function fundMachineChunk(chunk: MachineChunk, dependencies: MachineBillingDependencies = runtime): Promise<boolean> {
  if (chunk.provider === 'e2b') return fundE2BChunk(chunk)
  const id = machineChunkId(chunk)
  const prior = await dependencies.state(id, chunk)
  if (prior === 'settled') return true
  if (prior === 'different_sku') return false
  try {
    await dependencies.charge(chunk, id, machineChunkMicroUsd(chunk.size))
    return await dependencies.state(id, chunk) === 'settled'
  } catch (error) {
    if (error instanceof PaidResourceError && FUNDING_REFUSALS.has(error.code)) return false
    if (error instanceof PaidResourceError && error.code === 'usage_in_progress') return (await dependencies.state(id, chunk)) === 'settled'
    throw new Error('machine_chunk_charge_failed', { cause: error })
  }
}

const runtime: MachineBillingDependencies = {
  async state(id, chunk) {
    const { pool } = await import('@/lib/db')
    const { rows: [row] } = await pool.query<{ state: string }>(`SELECT CASE WHEN model=$2 THEN state ELSE 'different_sku' END AS state FROM hosted_usage WHERE id=$1`, [id, machineLedgerLabel(chunk)])
    return row?.state ?? null
  },
  async charge(chunk, id, cost) {
    const [{ hostedUsage }, { withSharedCredits }, { hostedBillingScope }] = await Promise.all([
      import('@/lib/abuse/runtime'), import('@/lib/credit-shares'), import('@/lib/abuse/context'),
    ])
    const label = machineLedgerLabel(chunk)
    await hostedBillingScope.run({ workspaceId: chunk.workspaceId, ownerId: chunk.ownerId, runId: chunk.runId, actorId: chunk.ownerId },
      () => withSharedCredits(chunk.workspaceId, payer => hostedUsage.reserve(payer, label, id, runtimeEnv(), cost)))
    // Prepaid: the chunk is charged in full when it starts, as Capy holds machine time ahead.
    await hostedUsage.settle(id, cost)
  },
}

/** Five minutes on a verified E2B SKU. Its receipt namespace cannot consume
 * a Cloudflare reservation for the same machine or run. */
async function fundE2BChunk(chunk: E2BMachineChunk): Promise<boolean> {
  const [{ pool }, { hostedUsage }, { withSharedCredits }, { hostedBillingScope }] = await Promise.all([
    import('@/lib/db'), import('@/lib/abuse/runtime'), import('@/lib/credit-shares'), import('@/lib/abuse/context'),
  ])
  if (!hostedUsage.metered) return false
  const id = machineChunkId(chunk)
  const cost = prepaidMachineMicroUsd(chunk.hourlyMicroUsd)
  const model = machineLedgerLabel(chunk)
  async function receipt() {
    const { rows: [row] } = await pool.query<{state: string}>(`SELECT CASE WHEN state='settled' AND (coalesce("unpaidMicroUsd",0)>0 OR "costMicroUsd" IS DISTINCT FROM $3)
      THEN 'unfunded' ELSE state END AS state FROM hosted_usage WHERE id=$1 AND model=$2
      AND "holdMicroUsd"=$3 AND "usageWorkspaceId"=$4 AND "executionOwnerId"=$5
      AND "inputTokens"=0 AND "outputTokens"=0`, [id, model, cost, chunk.workspaceId, chunk.ownerId])
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
      () => withSharedCredits(chunk.workspaceId, payer => hostedUsage.reserve(payer, model, id, runtimeEnv(), cost, true)))
    } catch (error) {
      if (!(error instanceof PaidResourceError) || error.code !== 'usage_in_progress') throw error
    }
    return await receipt() === 'settled'
  } catch (error) {
    if (error instanceof PaidResourceError && FUNDING_REFUSALS.has(error.code)) return false
    throw error
  }
}
