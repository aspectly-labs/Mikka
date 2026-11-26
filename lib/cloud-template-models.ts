import { z } from 'zod'
import sizes from '../scripts/e2b/machine-sizes.json'
import { harnessInfoSchema } from '@mikka/protocol/harness'
import type { OrderEntry } from './model-order-plan'
export const cloudTemplateKindSchema = z.enum(['desktop', 'claude', 'codex'])
export type CloudTemplateKind = z.infer<typeof cloudTemplateKindSchema>
const template = z.object({ templateId: z.string().regex(/^[A-Za-z0-9_-]+$/), models: z.array(harnessInfoSchema).max(4),
  baseTemplate: cloudTemplateKindSchema.optional(), preinstalled: z.boolean().optional(),
}).strict().refine(row => (row.baseTemplate === undefined) === (row.preinstalled === undefined))
const variant = z.object({
  kind:cloudTemplateKindSchema, size:z.enum(['small','medium','large','ultra']), templateId:z.string().regex(/^[A-Za-z0-9_-]+$/),
  cpuCount:z.number().int(), memoryMB:z.number().int(),
}).strict().refine(row => (row.kind !== 'desktop' || row.size === 'medium') && sizes[row.size].cpuCount === row.cpuCount && sizes[row.size].memoryMB === row.memoryMB)
export const cloudTemplateModelsSchema = z.object({
  version: z.literal(1), workerSha: z.string().regex(/^[a-f0-9]{40}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  templates: z.object({ desktop: template, claude: template, codex: template }).strict(),
  machineVariants:z.array(variant).max(9).optional(),
}).strict().refine(catalog => {
  const rows = catalog.machineVariants
  if (!rows) return true
  if (new Set(rows.map(r=>r.templateId)).size !== rows.length || new Set(rows.map(r=>r.kind+'/'+r.size)).size !== rows.length) return false
  return cloudTemplateKindSchema.options.every(kind => rows.some(r=>r.kind === kind && r.size === 'medium' && r.templateId === catalog.templates[kind].templateId))
})
export type CloudModelState = 'ready' | 'cloudModelsUnknown' | 'cloudModelNotReported'
export function cloudTemplateModels(env: Record<string, string | undefined> = process.env) {
  try {
    const result = cloudTemplateModelsSchema.parse(JSON.parse(env.MIKKA_CLOUD_TEMPLATE_MODELS ?? ''))
    if (result.workerSha !== env.MIKKA_CLOUD_WORKER_SHA
      || (result.sourceCommit !== undefined && result.sourceCommit !== env.MIKKA_CLOUD_WORKER_SOURCE_COMMIT)) return null
    for (const [kind, variable] of Object.entries({ desktop: 'E2B_BYO_COMPUTER_TEMPLATE', claude: 'E2B_CLAUDE_TEMPLATE', codex: 'E2B_CODEX_TEMPLATE' }) as [keyof typeof result.templates, string][]) {
      const row = result.templates[kind]
      if (row.templateId !== env[variable] || (row.baseTemplate !== undefined && row.baseTemplate !== kind)
        || (row.preinstalled !== undefined && row.preinstalled !== (row.templateId !== kind))) return null
    }
    return result
  } catch { return null }
}

function releasedCloudTemplates(env: Record<string, string | undefined>) {
  const catalogues = [cloudTemplateModels(env)]
  try {
    const previous = JSON.parse(env.MIKKA_CLOUD_RUNTIME_PREVIOUS ?? '')
    if (previous.version === 1 && previous.configuration && Object.values(previous.configuration).every(value => typeof value === 'string')) {
      catalogues.push(cloudTemplateModels(previous.configuration))
    }
  } catch { /* No previous release is configured. */ }
  return catalogues
}

/** A paused desktop's exact release image identifies the worker installed by
 * the release, independent of the currently selected template ID. */
export function releasedDesktopWorker(templateId: string, env: Record<string, string | undefined> = process.env) {
  for (const catalogue of releasedCloudTemplates(env)) {
    const desktop = catalogue?.templates.desktop
    if (desktop?.templateId === templateId && desktop.preinstalled === true) return catalogue?.workerSha
  }
  return undefined
}

/** Only release-gated catalogue IDs identify additive images. Bare official
 * names remain usable for rollback; arbitrary replacement IDs are refused. */
export function cloudTemplateOrigin(templateId: string, env: Record<string, string | undefined> = process.env): { kind: CloudTemplateKind; preinstalled: boolean } | null {
  const official = cloudTemplateKindSchema.safeParse(templateId)
  if (official.success) return { kind: official.data, preinstalled: false }
  for (const catalogue of releasedCloudTemplates(env)) {
    if (!catalogue) continue
    const variant = catalogue.machineVariants?.find(row => row.templateId === templateId)
    if (variant) return { kind:variant.kind, preinstalled:true }
    for (const kind of cloudTemplateKindSchema.options) {
      const row = catalogue.templates[kind]
      if (row.templateId === templateId && row.baseTemplate === kind && row.preinstalled === true) return { kind, preinstalled: true }
    }
  }
  return null
}

/** Persisted provenance lets an existing task retain its VM across more than
 * one release. Only the host writes this field when selecting a gated image. */
export function threadMachineTemplateKind(machine: { snapshotId?: unknown; templateKind?: unknown } | null | undefined,
  env: Record<string, string | undefined> = process.env): CloudTemplateKind | null {
  if (!machine || typeof machine.snapshotId !== 'string') return null
  const known = cloudTemplateOrigin(machine.snapshotId, env)
  const stored = cloudTemplateKindSchema.safeParse(machine.templateKind)
  if (stored.success) return known && known.kind !== stored.data ? null : stored.data
  return known?.kind ?? null
}
/** The release proves the selected image has its Agent. Credentials admit models. */
export type CloudModelPurpose = 'task' | 'desktop' | 'cloudflare_task' | 'repository_admission'
export function cloudModelSupport(entry: Pick<OrderEntry, 'harness' | 'model' | 'source'>, purpose: CloudModelPurpose = 'task', env: Record<string, string | undefined> = process.env): CloudModelState {
  // The protected task image release verifies both native binaries. Its
  // subscription catalogue and current allowance are authorized by dispatch.
  // Mikka 额度 reaches any catalogue model through the model gateway, on either image.
  // Repository admission selects and validates the machine after model selection.
  if (purpose === 'repository_admission') return 'ready'
  if (purpose === 'cloudflare_task') return entry.source.kind === 'subscription' || entry.source.kind === 'credits' ? 'ready' : 'cloudModelNotReported'
  const catalogue = cloudTemplateModels(env)
  if (!catalogue) return 'cloudModelsUnknown'
  const kind = purpose === 'desktop' ? 'desktop' : entry.harness === 'claude_code' ? 'claude' : 'codex'
  const harness = catalogue.templates[kind].models.find(info => info.harness === entry.harness && info.installed)
  if (!harness) return 'cloudModelNotReported'
  return 'ready'
}
