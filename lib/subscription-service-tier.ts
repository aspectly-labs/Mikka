import { z } from 'zod'

/** Internal Coordinator / Bot request policy, independent of the frozen model and effort. */
export const subscriptionModelRequestPolicySchema = z.strictObject({
  codexServiceTier: z.enum(['priority', 'ultrafast']).optional(),
  claudeSpeed: z.literal('fast').optional(),
  apiKeyPro: z.literal(true).optional(),
  apiKeyServiceTier: z.enum(['fast', 'ultrafast']).optional(),
  /** Daybreak frozen with the turn, checked against the route then (`access_programs.cyber`). */
  codexCyberAccessProgram: z.enum(['daybreak_blue', 'daybreak_red']).optional(),
  apiKeyCyberAccessProgram: z.enum(['daybreak_blue', 'daybreak_red']).optional(),
})
export type SubscriptionModelRequestPolicy = z.infer<typeof subscriptionModelRequestPolicySchema>

export interface SubscriptionCatalogueModel {
  id: string
  name?: string
  prioritySupported?: boolean
  ultrafastSupported?: boolean
  fastSupported?: boolean
  /** Reasoning levels the account's catalogue lists for the model (packages/subscription-worker/models.go). */
  efforts?: string[]
  /** The provider's default level, one of `efforts`. */
  defaultEffort?: string
  /** Daybreak tiers (`blue`, `red`) the account's catalogue offers the model (`available_access_programs`). */
  daybreak?: ('blue' | 'red')[]
}
export interface SubscriptionModelCatalogue {
  revision: number | string
  models: string[]
  priorityVersion?: 1
  prioritySupport?: Record<string, boolean>
  ultrafastSupport?: Record<string, boolean>
  fastSupport?: Record<string, boolean>
  /** Model → the reasoning levels its catalogue lists; `defaultEffort` model → the provider's default level. */
  effortSupport?: Record<string, string[]>
  defaultEffort?: Record<string, string>
  /** Model → the Daybreak tiers the seat's catalogue offers it: the subscription's Daybreak access (lib/model-capabilities-server.ts). */
  daybreakSupport?: Record<string, ('blue' | 'red')[]>
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
