import 'server-only'
import type { Pool } from 'pg'
import { catalogIdFor, type CatalogModel } from './model-catalog'
import { daybreakTierFor, modelKeyOf, PRO_MODELS, resolveModelCapabilities, type DaybreakAccess, type DaybreakTier, type ModelCapabilities } from './model-capabilities'
import { resolveSpeedModesFromEvidence, type ModelSpeedMode } from './model-routing'

/** One model on one route, as the menu and the run name it. */
export type CapabilityTarget =
  | { source: 'credits'; modelId: string }
  | { source: 'subscription'; connectionId: string; provider: string; modelId: string }
  | { source: 'byok'; provider: string; modelId: string; responsesApi?: boolean; advertisedSpeedModes?: readonly ModelSpeedMode[]; daybreak?: DaybreakAccess | null }

interface ConnectionCatalogue {
  current: boolean
  priority: Record<string, boolean> | null
  ultrafast: Record<string, boolean> | null
  fast: Record<string, boolean> | null
  efforts: Record<string, string[]> | null
  defaults: Record<string, string> | null
  /** Model → the Daybreak tiers the account's catalogue offers it (`available_access_programs.cyber`, models.go). */
  daybreak: Record<string, string[]> | null
}

/** Pro on this route: Mikka 额度 or an OpenAI key, a model in PRO_MODELS. No subscription seat offers it (Capy). */
const proOn = (route: 'credits' | 'byok', provider: string, modelId: string) =>
  (route === 'credits' || provider === 'openai') && PRO_MODELS.has(modelKeyOf(modelId, provider))

/** A seat's tier for a model: what its catalogue offers, Blue before Red, as Codex picks (`ModelAccessPrograms::daybreak`). */
const seatTier = (tiers: readonly string[] | undefined): DaybreakTier | undefined =>
  tiers?.includes('blue') ? 'blue' : tiers?.includes('red') ? 'red' : undefined

const stringLists = (value: unknown): Record<string, string[]> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, string[]> = {}
  for (const [model, list] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(list)) out[model] = list.filter((level): level is string => typeof level === 'string')
  }
  return out
}
const strings = (value: unknown): Record<string, string> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

/**
 * Reads, once, what the capabilities of a set of models depend on: the named subscriptions' own catalogues (no
 * credential, only the stored projection) and the live Gateway catalogue; then answers per model, synchronously.
 * A catalogue from an older connection revision is not evidence (lib/subscription-service-tier.ts).
 */
export async function modelCapabilityReader(query: Pick<Pool, 'query'>, connectionIds: readonly string[], gateway?: ReadonlyMap<string, CatalogModel>) {
  const { liveCatalogIndex, gatewayEntryFor, jsonBoolMap } = await import('./model-order')
  const ids = [...new Set(connectionIds)]
  const [catalog, rows] = await Promise.all([
    gateway ? Promise.resolve(gateway) : liveCatalogIndex(false),
    ids.length ? query.query<{ id: string; epoch: string; revision: string | null; prioritySupport: unknown; ultrafastSupport: unknown; fastSupport: unknown; effortSupport: unknown; defaultEffort: unknown; daybreakSupport: unknown }>(
      `SELECT id::text AS id, epoch::text AS epoch, "modelCatalog"->>'revision' AS revision,
         "modelCatalog"->'prioritySupport' AS "prioritySupport", "modelCatalog"->'ultrafastSupport' AS "ultrafastSupport",
         "modelCatalog"->'fastSupport' AS "fastSupport", "modelCatalog"->'effortSupport' AS "effortSupport",
         "modelCatalog"->'defaultEffort' AS "defaultEffort", "modelCatalog"->'daybreakSupport' AS "daybreakSupport"
       FROM byos_connections WHERE id::text = ANY($1)`, [ids]).then(result => result.rows) : Promise.resolve([]),
  ])
  const connections = new Map<string, ConnectionCatalogue>(rows.map(row => {
    const current = row.revision !== null && row.revision === row.epoch
    return [row.id, {
      current, priority: jsonBoolMap(row.prioritySupport), ultrafast: jsonBoolMap(row.ultrafastSupport), fast: jsonBoolMap(row.fastSupport),
      efforts: current ? stringLists(row.effortSupport) : null, defaults: current ? strings(row.defaultEffort) : null,
      daybreak: current ? stringLists(row.daybreakSupport) : null,
    }]
  }))
  const gatewayEntry = (modelId: string) => catalog.get(modelId) ?? (catalogIdFor(modelId) ? catalog.get(catalogIdFor(modelId)!) : undefined)

  return function capabilities(target: CapabilityTarget): ModelCapabilities {
    if (target.source === 'credits') {
      const entry = gatewayEntry(target.modelId)
      return resolveModelCapabilities({
        modelId: target.modelId, advertisedEfforts: entry?.reasoning, contextWindow: entry?.contextWindow,
        speedModes: resolveSpeedModesFromEvidence({ catalogSpeedModes: entry?.speedModes, catalogTags: entry?.tags }),
        // Daybreak on Mikka 额度 would be Mikka's own grant; the Gateway catalogue names none, so none is offered.
        pro: proOn('credits', 'mikka', target.modelId),
      })
    }
    if (target.source === 'byok') {
      const entry = gatewayEntryFor(catalog, target.modelId, target.provider)
      return resolveModelCapabilities({
        modelId: target.modelId, provider: target.provider, advertisedEfforts: entry?.reasoning,
        contextWindow: (entry ?? gatewayEntry(target.modelId))?.contextWindow,
        speedModes: resolveSpeedModesFromEvidence(target.advertisedSpeedModes !== undefined
          ? { advertised: target.advertisedSpeedModes }
          : { catalogSpeedModes: entry?.speedModes, catalogTags: entry?.tags }),
        pro: target.responsesApi === true && proOn('byok', target.provider, target.modelId),
        // The key's own Daybreak access (refreshApiKeyDaybreak), Capy's per-credential `DaybreakAccess`.
        daybreak: target.provider === 'openai' ? daybreakTierFor(target.daybreak, target.modelId) : undefined,
      })
    }
    const connection = connections.get(target.connectionId)
    const model = target.modelId
    const routed = gatewayEntryFor(catalog, model, target.provider)
    // The same evidence order Settings › Models uses (lib/model-order.ts orderCandidates).
    const speedModes = target.provider === 'codex'
      ? resolveSpeedModesFromEvidence(connection?.current ? { prioritySupported: connection.priority?.[model], ultrafastSupported: connection.ultrafast?.[model] } : {})
      : resolveSpeedModesFromEvidence({
          fastSupported: connection?.current ? connection.fast?.[model] : undefined,
          ultrafastSupported: connection?.current ? connection.ultrafast?.[model] : undefined,
          catalogSpeedModes: routed?.speedModes,
          catalogTags: routed?.tags,
        })
    return resolveModelCapabilities({
      modelId: model, provider: target.provider, speedModes,
      // The subscription's own catalogue names no context window; the Gateway's entry for the same model does.
      contextWindow: (routed ?? gatewayEntry(model))?.contextWindow,
      advertisedEfforts: connection?.efforts && Object.hasOwn(connection.efforts, model) ? connection.efforts[model] : undefined,
      advertisedDefault: connection?.defaults?.[model],
      // A seat never offers Pro; Codex's account catalogue says which Daybreak tiers it offers the model.
      pro: false,
      daybreak: target.provider === 'codex' ? seatTier(connection?.daybreak?.[model]) : undefined,
    })
  }
}
