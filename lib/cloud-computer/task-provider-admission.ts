import 'server-only'
import { z } from 'zod'
import { getNodeEnv } from '@/lib/env/public'
import { readEnv, runtimeEnv } from '@/lib/env/server'
import { ComputerError } from '../computer/store'
import { isCloudEdition } from '../edition'
import { productionFlagDefault, taskProviderFlag } from '../feature-flags'
import type { Plan } from '../governance/policy'
import { posthogConfig } from '../posthog-config'
import { serverTaskProviderVariant } from '../posthog-server'
import { DEFAULT_MACHINE_SIZE, machineSkuGeometry, provisionableMachineSize, type E2BMachineSize, type MachineGeometry, type MachineProvider, type MachineSize, type MachineSku } from './machine-pricing'

export const taskProviderUnavailableMessage = (provider: MachineProvider) =>
  `${provider === 'cloudflare' ? 'Cloudflare' : 'E2B'} coding task unavailable. Retry the run.`

export class TaskProviderAdmissionUnavailable extends ComputerError {
  constructor(readonly provider: MachineProvider, readonly allowLocalRecovery = false, options?: ErrorOptions) {
    super(503, taskProviderUnavailableMessage(provider))
    this.cause = options?.cause
  }
}

/** Legacy E2B installations can keep their early readiness check when there
 * is no remote or local selector to change that provider. This reads no flag
 * remotely, including when the admission key is replayed. */
export function taskProviderSelectionConfigured(workspaceId: string) {
  const nodeEnv = getNodeEnv()
  const localConfiguration = (nodeEnv === 'development' || nodeEnv === 'test') && Boolean(readEnv('MIKKA_FLAG_OVERRIDES'))
  return Boolean(posthogConfig.token) || localConfiguration || productionFlagDefault(taskProviderFlag) === 'cloudflare' || legacyCloudflareWorkspace(workspaceId)
}

const legacyCloudflareWorkspace = (workspaceId: string) =>
  readEnv('MIKKA_CLOUDFLARE_TASK_WORKSPACES')?.split(/[,\s]+/).includes(workspaceId) === true

export async function selectTaskProvider(
  actor: { userId: string; workspaceId: string },
  explicitCloudflare: boolean,
  previous?: MachineProvider,
): Promise<{ provider: MachineProvider; source: 'remote' | 'legacy_workspace' | 'legacy_explicit' | 'previous' | 'default' }> {
  const remote = await serverTaskProviderVariant(actor.userId, actor.workspaceId)
  if (remote) return { provider: remote, source: 'remote' }
  if (explicitCloudflare) return { provider: 'cloudflare', source: 'legacy_explicit' }
  if (legacyCloudflareWorkspace(actor.workspaceId)) {
    return { provider: 'cloudflare', source: 'legacy_workspace' }
  }
  if (previous) return { provider: previous, source: 'previous' }
  const fallback = productionFlagDefault(taskProviderFlag)
  return { provider: fallback === 'cloudflare' ? fallback : 'e2b', source: 'default' }
}

const e2bSizes: E2BMachineSize[] = ['small', 'medium', 'large', 'ultra']
const cloudflareSizes: MachineSize[] = ['standard-1', 'standard-2', 'standard-3', 'standard-4', 'standard-4-16']

const hardwareLimit = z.strictObject({ vcpu: z.number().positive(), ramGib: z.number().positive() })
const hardwareLimitsByPlan = z.strictObject({
  free: hardwareLimit.nullable().optional(),
  pro: hardwareLimit.nullable().optional(),
  enterprise: hardwareLimit.nullable().optional(),
})

/**
 * Default Mikka Cloud task-machine limits by workspace plan (#3330):
 * - Free ($0): cloud machines unavailable (`null`); paid plan required.
 * - Pro ($20/mo): up to Large (4 vCPU / 16 GiB — Small, Medium, Large),
 *   matching Capy's $20 tier geometry while billing at E2B list price.
 * - Enterprise: up to Ultra (8 vCPU / 32 GiB).
 * Operators may override per-plan limits via `MIKKA_TASK_MACHINE_PLAN_LIMITS`.
 */
export const DEFAULT_CLOUD_TASK_MACHINE_PLAN_LIMITS: Readonly<Record<Plan, MachineGeometry | null>> = {
  free: null,
  pro: { vcpu: 4, ramGib: 16 },
  enterprise: { vcpu: 8, ramGib: 32 },
}

export function configuredTaskMachinePlanLimits(
  env: Readonly<Record<string, string | undefined>> = runtimeEnv(),
): Partial<Record<Plan, MachineGeometry | null>> | null {
  const configured = env.MIKKA_TASK_MACHINE_PLAN_LIMITS?.trim()
  if (configured) {
    let limits: unknown
    try { limits = JSON.parse(configured) }
    catch (cause) { throw new Error('Invalid task machine plan limits', { cause }) }
    const parsed = hardwareLimitsByPlan.parse(limits)
    return isCloudEdition(env) ? { ...DEFAULT_CLOUD_TASK_MACHINE_PLAN_LIMITS, ...parsed } : parsed
  }
  return isCloudEdition(env) ? DEFAULT_CLOUD_TASK_MACHINE_PLAN_LIMITS : null
}

/** Borrow the current Workspace lease to resolve the effective cloud-machine plan ceiling.
 * Returns `null` when the plan disallows cloud machines, a geometry cap when limited,
 * or `undefined` when uncapped (community/self-hosted without explicit operator limits). */
export async function taskMachinePlanLimit(workspaceId: string): Promise<MachineGeometry | null | undefined> {
  const limitsByPlan = configuredTaskMachinePlanLimits()
  if (!limitsByPlan) return undefined
  const { acquireHostedQuota } = await import('../governance/hosted-quota')
  const lease = await acquireHostedQuota(workspaceId)
  try { return limitsByPlan[lease.cloudMachinePlan] }
  finally { await lease.close() }
}

function chooseSku(catalog: MachineSku[], requested: MachineSku | undefined, fallback: MachineSku) {
  if (!requested) return fallback
  const target = machineSkuGeometry(requested)
  return catalog.find(sku => {
    const hardware = machineSkuGeometry(sku)
    return hardware.vcpu >= target.vcpu && hardware.ramGib >= target.ramGib
  }) ?? catalog.at(-1)!
}

/** Map geometry across providers, then enforce both account quota and the plan. */
export function taskComputeSku(provider: MachineProvider, requested: { cloudflare?: MachineSize; e2b?: E2BMachineSize },
  verifiedQuota: boolean, max?: MachineGeometry | null): MachineSku | null {
  if (max === null) return null
  const cloudflare = requested.cloudflare ? { provider: 'cloudflare' as const, size: requested.cloudflare } : undefined
  const e2b = requested.e2b ? { provider: 'e2b' as const, size: requested.e2b } : undefined
  const catalog: MachineSku[] = provider === 'cloudflare'
    ? cloudflareSizes.filter(size => provisionableMachineSize(size, verifiedQuota).size === size).map(size => ({ provider, size }))
    : e2bSizes.map(size => ({ provider, size }))
  const intended = provider === 'cloudflare'
    ? cloudflare ? { provider, size: provisionableMachineSize(cloudflare.size, verifiedQuota).size }
      : chooseSku(catalog, e2b, { provider, size: DEFAULT_MACHINE_SIZE })
    : e2b ?? chooseSku(catalog, cloudflare, { provider, size: 'medium' })
  if (!max) return intended
  const target = machineSkuGeometry(intended)
  return catalog.findLast(sku => {
    const hardware = machineSkuGeometry(sku)
    return hardware.vcpu <= Math.min(max.vcpu, target.vcpu) && hardware.ramGib <= Math.min(max.ramGib, target.ramGib)
  }) ?? null
}
