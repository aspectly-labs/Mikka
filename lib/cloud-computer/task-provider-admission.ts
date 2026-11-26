import 'server-only'
import { z } from 'zod'
import { productionFlagDefault, taskProviderFlag } from '../feature-flags'
import { serverTaskProviderVariant } from '../posthog-server'
import { DEFAULT_MACHINE_SIZE, machineSkuGeometry, provisionableMachineSize, type E2BMachineSize, type MachineGeometry, type MachineProvider, type MachineSize, type MachineSku } from './machine-pricing'

export const taskProviderUnavailableMessage = (provider: MachineProvider) =>
  `${provider === 'cloudflare' ? 'Cloudflare' : 'E2B'} coding task unavailable. Retry the run.`

export async function selectTaskProvider(
  actor: { userId: string; workspaceId: string },
  explicitCloudflare: boolean,
  previous?: MachineProvider,
): Promise<{ provider: MachineProvider; source: 'remote' | 'legacy_workspace' | 'legacy_explicit' | 'previous' | 'default' }> {
  const remote = await serverTaskProviderVariant(actor.userId, actor.workspaceId)
  if (remote) return { provider: remote, source: 'remote' }
  if (explicitCloudflare) return { provider: 'cloudflare', source: 'legacy_explicit' }
  if (process.env.MIKKA_CLOUDFLARE_TASK_WORKSPACES?.split(/[,\s]+/).includes(actor.workspaceId)) {
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
  free: hardwareLimit.optional(),
  pro: hardwareLimit.optional(),
  enterprise: hardwareLimit.optional(),
})

/** Borrow the current Workspace lease when an operator configured plan maxima. */
export async function taskMachinePlanLimit(workspaceId: string): Promise<MachineGeometry | undefined> {
  const configured = process.env.MIKKA_TASK_MACHINE_PLAN_LIMITS?.trim()
  if (!configured) return undefined
  let limits: unknown
  try { limits = JSON.parse(configured) }
  catch (cause) { throw new Error('Invalid task machine plan limits', { cause }) }
  const parsed = hardwareLimitsByPlan.parse(limits)
  const { acquireHostedQuota } = await import('../governance/hosted-quota')
  const lease = await acquireHostedQuota(workspaceId)
  try { return parsed[lease.plan] }
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
  verifiedQuota: boolean, max?: MachineGeometry): MachineSku | null {
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
