import { cloudTemplateModels, type CloudTemplateKind } from '@/lib/cloud-template-models'
import { machineSkuListPrice, type E2BMachineSize } from './machine-pricing'
import sizes from '../../scripts/e2b/machine-sizes.json'

export type { E2BMachineSize } from './machine-pricing'
export const E2B_MACHINE_SIZES = Object.keys(sizes) as [E2BMachineSize, ...E2BMachineSize[]]
type Env = Record<string,string|undefined>

function ratedE2BSku(size: E2BMachineSize): E2BComputeSpec | null {
  const terms = machineSkuListPrice({ provider: 'e2b', size })
  if (terms?.basis !== 'provisioned_hour') return null
  return { provider: 'e2b', size, ...sizes[size], hourlyMicroUsd: terms.hourlyMicroUsd, pricingVersion: terms.version }
}

/** Only hardware observed from the provider in the approved release qualifies for metering. */
export function e2bTemplatePricing(templateId: string, env: Env = process.env) {
  const row = cloudTemplateModels(env)?.machineVariants?.find(candidate => candidate.templateId === templateId)
  if (!row) return null
  const size = sizes[row.size]
  if (row.cpuCount !== size.cpuCount || row.memoryMB !== size.memoryMB) return null
  return ratedE2BSku(row.size)
}

export function e2bTemplateForSize(kind: CloudTemplateKind, size: E2BMachineSize = 'medium', env: Env = process.env) {
  return cloudTemplateModels(env)?.machineVariants?.find(candidate => candidate.kind === kind && candidate.size === size)?.templateId ?? null
}

export type E2BComputeSpec = {
  provider: 'e2b'
  pricingVersion: string
  size: E2BMachineSize
  cpuCount: number
  memoryMB: number
  hourlyMicroUsd: number
}

/** Settings show only sizes available in the published provider catalogue. */
export function e2bMachineOptions(env: Env = process.env) {
  return cloudTemplateModels(env)?.machineVariants?.flatMap(row => {
    const rate = ratedE2BSku(row.size)
    return rate ? [{ kind: row.kind, ...rate }] : []
  }) ?? []
}

export function e2bPricingForHardware(cpuCount: number, memoryMB: number): E2BComputeSpec | null {
  const size = E2B_MACHINE_SIZES.find(key => sizes[key].cpuCount === cpuCount && sizes[key].memoryMB === memoryMB)
  return size ? ratedE2BSku(size) : null
}
