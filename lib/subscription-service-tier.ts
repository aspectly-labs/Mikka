import { z } from 'zod'
import type { ModelSpeedMode } from './model-routing'

/** Internal Coordinator / Bot request policy, independent of the frozen model and effort. */
export const subscriptionModelRequestPolicySchema = z.strictObject({
  codexServiceTier: z.enum(['priority', 'ultrafast']).optional(),
  claudeSpeed: z.literal('fast').optional(),
})
export type SubscriptionModelRequestPolicy = z.infer<typeof subscriptionModelRequestPolicySchema>

export interface SubscriptionCatalogueModel {
  id: string
  name?: string
  prioritySupported?: boolean
  ultrafastSupported?: boolean
  fastSupported?: boolean
}
export interface SubscriptionModelCatalogue {
  revision: number | string
  models: string[]
  priorityVersion?: 1
  prioritySupport?: Record<string, boolean>
  ultrafastSupport?: Record<string, boolean>
  fastSupport?: Record<string, boolean>
}
export type CodexPrioritySupport = 'supported' | 'unsupported' | 'unknown'

function readCatalogueFlag(
  catalogue: unknown,
  revision: number,
  modelId: string,
  field: 'prioritySupport' | 'ultrafastSupport' | 'fastSupport',
  requirePriorityVersion: boolean,
): CodexPrioritySupport {
  if (!catalogue || typeof catalogue !== 'object' || Array.isArray(catalogue)) return 'unknown'
  const value = catalogue as Partial<SubscriptionModelCatalogue>
  if ((requirePriorityVersion && value.priorityVersion !== 1) || !Number.isSafeInteger(revision) || revision < 1
    || (typeof value.revision !== 'number' && typeof value.revision !== 'string') || Number(value.revision) !== revision
    || !Array.isArray(value.models) || !value.models.includes(modelId)) return 'unknown'
  const map = value[field]
  if (!map || typeof map !== 'object' || Array.isArray(map) || !Object.hasOwn(map, modelId)) return 'unknown'
  return map[modelId] === true ? 'supported' : map[modelId] === false ? 'unsupported' : 'unknown'
}

/** Only the current credential epoch's advertised capability can enable Fast.
 * This projection reuses the fresh access read; it never probes the provider. */
export function codexPrioritySupport(catalogue: unknown, revision: number, modelId: string): CodexPrioritySupport {
  return readCatalogueFlag(catalogue, revision, modelId, 'prioritySupport', true)
}

/** Only the current credential epoch's advertised capability can enable Codex Ultrafast. */
export function codexUltrafastSupport(catalogue: unknown, revision: number, modelId: string): CodexPrioritySupport {
  return readCatalogueFlag(catalogue, revision, modelId, 'ultrafastSupport', true)
}

/** Only the current credential epoch's advertised capability can enable Claude Fast mode. */
export function claudeFastSupport(catalogue: unknown, revision: number, modelId: string): CodexPrioritySupport {
  return readCatalogueFlag(catalogue, revision, modelId, 'fastSupport', false)
}

/** Projects verified speed modes from a subscription's current-epoch catalogue. Zero model-name guessing. */
export function subscriptionCatalogueSpeedModes(
  provider: 'codex' | 'claude',
  catalogue: unknown,
  revision: number,
  modelId: string,
): readonly ModelSpeedMode[] {
  if (provider === 'codex') {
    const modes: ModelSpeedMode[] = []
    if (codexPrioritySupport(catalogue, revision, modelId) === 'supported') modes.push('fast')
    if (codexUltrafastSupport(catalogue, revision, modelId) === 'supported') modes.push('ultrafast')
    return modes
  }
  return claudeFastSupport(catalogue, revision, modelId) === 'supported' ? ['fast'] : []
}
