import { cloudTemplateModels, type CloudTemplateKind } from '@/lib/cloud-template-models'
import sizes from '../../scripts/e2b/machine-sizes.json'

export type E2BMachineSize = keyof typeof sizes
export const E2B_MACHINE_SIZES = Object.keys(sizes) as [E2BMachineSize, ...E2BMachineSize[]]
type Env = Record<string,string|undefined>

/** Only hardware observed from the provider in the approved release qualifies for metering. */
export function e2bTemplatePricing(templateId: string, env: Env = process.env) {
  const row = cloudTemplateModels(env)?.machineVariants?.find(candidate => candidate.templateId === templateId)
  if (!row) return null
  const size = sizes[row.size]
  if (row.cpuCount !== size.cpuCount || row.memoryMB !== size.memoryMB) return null
  return { size:row.size, ...size }
}

export function e2bTemplateForSize(kind: CloudTemplateKind, size: E2BMachineSize = 'medium', env: Env = process.env) {
  return cloudTemplateModels(env)?.machineVariants?.find(candidate => candidate.kind === kind && candidate.size === size)?.templateId ?? null
}

export type E2BComputeSpec = {
  size: E2BMachineSize
  cpuCount: number
  memoryMB: number
  hourlyMicroUsd: number
}

/** Settings show only sizes available in the published provider catalogue. */
export function e2bMachineOptions(env: Env = process.env) {
  return cloudTemplateModels(env)?.machineVariants?.map(row => ({
    kind: row.kind, size: row.size, ...sizes[row.size],
  })) ?? []
}
