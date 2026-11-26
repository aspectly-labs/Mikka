import 'server-only'
import { productionFlagDefault, taskProviderFlag } from '../feature-flags'
import { serverTaskProviderVariant } from '../posthog-server'
import { DEFAULT_MACHINE_SIZE, machineSkuGeometry, provisionableMachineSize, type E2BMachineSize, type MachineProvider, type MachineSize, type MachineSku } from './machine-pricing'

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

/** Resolve a previously selected size by geometry if the destination provider changed. */
export function taskComputeSku(provider: MachineProvider, requested: { cloudflare?: MachineSize; e2b?: E2BMachineSize }, verifiedQuota: boolean): MachineSku {
  if (provider === 'cloudflare') {
    const target = requested.e2b && machineSkuGeometry({ provider: 'e2b', size: requested.e2b })
    const size = requested.cloudflare ?? (target ? cloudflareSizes.find(size => {
      const hardware = machineSkuGeometry({ provider, size })
      return hardware.vcpu >= target.vcpu && hardware.ramGib >= target.ramGib
    }) ?? cloudflareSizes.at(-1)! : DEFAULT_MACHINE_SIZE)
    return { provider, size: provisionableMachineSize(size, verifiedQuota).size }
  }
  const target = requested.cloudflare && machineSkuGeometry({ provider: 'cloudflare', size: requested.cloudflare })
  const size = requested.e2b ?? (target ? e2bSizes.find(size => {
    const hardware = machineSkuGeometry({ provider, size })
    return hardware.vcpu >= target.vcpu && hardware.ramGib >= target.ramGib
  }) ?? e2bSizes.at(-1)! : 'medium')
  return { provider, size }
}
