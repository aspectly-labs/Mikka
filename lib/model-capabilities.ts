/**
 * What one model can be asked for, wherever it is picked (the chat's model menu, 新建 Bot, Settings › Models,
 * the iOS app): its reasoning levels, the provider's default level and its serving speeds. One resolver, so
 * every picker adapts to the model the same way (public decision 2026-11-25-1700).
 *
 * Levels come from the provider first: a subscription's own account catalogue (Codex `/backend-api/codex/models`
 * `supported_reasoning_levels`, Anthropic `/v1/models` `capabilities.effort`, read by
 * packages/subscription-worker/models.go) and the Gateway catalogue (`reasoning_options`) for Mikka 额度 and API
 * keys. Mikka's built-in list (lib/model-routing.ts `supportedModelEfforts`) answers only for a model no
 * catalogue describes. A level the provider lists but a Mikka run cannot carry yet (Codex's `ultra`) is kept
 * apart as `providerOnly`, never offered.
 *
 * Pure and client-safe; lib/model-capabilities-server.ts reads the catalogues.
 */
import { MODEL_ROUTING_EFFORTS, supportedModelEfforts, type ModelRoutingEffort, type ModelServiceTier, type ModelSpeedMode } from './model-routing'
import type { OrderHarness } from './model-order-plan'
import { catalogIdFor } from './model-catalog'

/** OpenAI's Trusted Access for Cyber tiers (「Daybreak」); a route carries at most one. */
export const DAYBREAK_TIERS = ['blue', 'red'] as const
export type DaybreakTier = typeof DAYBREAK_TIERS[number]
export type CyberAccessProgram = 'daybreak_blue' | 'daybreak_red'
/** The Responses API wire value for a tier (`access_programs.cyber`, openai/codex codex-api/src/common.rs). */
export const cyberAccessProgram = (tier: DaybreakTier): CyberAccessProgram => tier === 'red' ? 'daybreak_red' : 'daybreak_blue'
/** The tier behind a Responses API wire value, or undefined for anything else. */
export const daybreakTierFromProgram = (program: unknown): DaybreakTier | undefined =>
  program === 'daybreak_red' ? 'red' : program === 'daybreak_blue' ? 'blue' : undefined

export interface ModelCapabilities {
  /** The levels a run of this model can carry, lowest first; empty when it takes none. */
  efforts: ModelRoutingEffort[]
  /** The provider's own default level, when it names one of `efforts`. */
  defaultEffort?: ModelRoutingEffort
  /** Where `efforts` came from: the provider's catalogue, Mikka's built-in list, or nothing known. */
  effortSource: 'provider' | 'builtin' | 'none'
  /** Levels the provider lists that a Mikka run cannot carry yet; shown nowhere, kept for diagnostics. */
  providerOnly?: string[]
  /** Serving speeds the provider advertises for this model on this route (`fast`, `ultrafast`). */
  speedModes: ModelSpeedMode[]
  /** The model's context window in tokens, from the Gateway catalogue; absent when no catalogue names it. */
  contextWindow?: number
  /** Pro (`reasoning.mode: "pro"`) can be asked for on this route: an OpenAI model on Mikka 额度 or an API key (PRO_MODELS). */
  pro?: boolean
  /** The Daybreak tier this route grants for the model; absent when it grants none, and the picker shows no switch. */
  daybreak?: DaybreakTier
}

import { CATALOG_PRO_MODELS, catalogProviderHarness, catalogProviderLab } from './model-catalog-metadata'

/**
 * The models Pro runs on, centralized in `lib/model-catalog-metadata.ts`
 * (every one is offered on credits and OpenAI API keys, never on a subscription seat).
 */
export const PRO_MODELS: ReadonlySet<string> = CATALOG_PRO_MODELS

/**
 * One model, whatever runs it (Capy's `lab/id-without-prefix`): the routes of the same model — Mikka 额度, a plan, a
 * key — share this key, so the picker lists the model once. The lab is the
 * catalogue's vendor, else the provider's lab, else (a custom provider) the route's label, as Capy's; the id is the
 * bare model id as the CLIs name it (`builtinKey`).
 */
export function modelKeyOf(modelId: string, provider: string, routeLabel = ''): string {
  if (provider === 'custom') return `${routeLabel.trim().toLowerCase() || 'custom'}/${modelId.trim()}`
  const id = modelId.trim().toLowerCase()
  const slash = id.indexOf('/')
  const name = id.slice(slash + 1)
  const bare = name.startsWith('claude-') ? name.replace(/\./g, '-') : name
  const vendor = slash >= 0 ? id.slice(0, slash) : catalogIdFor(modelId)?.split('/')[0]
  const lab = catalogProviderLab(provider) ?? vendor ?? provider.toLowerCase()
  return `${lab}/${bare}`
}

const RUNNABLE = new Set<string>(MODEL_ROUTING_EFFORTS)

/** Mikka's built-in list names models as their CLIs do (`claude-opus-5-5`, `gpt-6-sol`), without a vendor prefix. */
function builtinKey(modelId: string): string {
  const bare = modelId.trim().toLowerCase().split('/').pop() ?? ''
  return bare.startsWith('claude-') ? bare.replace(/\./g, '-') : bare
}

/** The CLI family whose built-in list describes a model. */
export function capabilityHarness(modelId: string, provider?: string): OrderHarness {
  return catalogProviderHarness(provider) ?? (/(^|\/)(gpt|o\d)/i.test(modelId) ? 'codex' : 'claude_code')
}

export function resolveModelCapabilities(input: {
  modelId: string
  provider?: string
  /** The provider's levels for this model; undefined or null when its catalogue said nothing. */
  advertisedEfforts?: readonly string[] | null
  advertisedDefault?: string | null
  speedModes?: readonly ModelSpeedMode[] | null
  /** The catalogue's context window in tokens; null or absent when it names none. */
  contextWindow?: number | null
  /** Pro is offered on this route (see PRO_MODELS); false or absent: not offered. */
  pro?: boolean
  /** The Daybreak tier the route's credential or seat was granted for this model. */
  daybreak?: DaybreakTier | null
}): ModelCapabilities {
  const speedModes = [...(input.speedModes ?? [])]
  const context = {
    pro: input.pro === true,
    ...(input.contextWindow && input.contextWindow > 0 ? { contextWindow: input.contextWindow } : {}),
    ...(input.daybreak ? { daybreak: input.daybreak } : {}),
  }
  if (input.advertisedEfforts) {
    const efforts = MODEL_ROUTING_EFFORTS.filter(level => input.advertisedEfforts!.includes(level))
    const providerOnly = input.advertisedEfforts.filter(level => !RUNNABLE.has(level))
    const defaultEffort = efforts.find(level => level === input.advertisedDefault)
    return {
      efforts, effortSource: 'provider', speedModes, ...context,
      ...(defaultEffort ? { defaultEffort } : {}),
      ...(providerOnly.length ? { providerOnly } : {}),
    }
  }
  const builtin = supportedModelEfforts(builtinKey(input.modelId), capabilityHarness(input.modelId, input.provider))
  return { efforts: [...builtin], effortSource: builtin.length ? 'builtin' : 'none', speedModes, ...context }
}

/** A saved level this model can run, else null (the model's own default). */
export function effortFor(capabilities: Pick<ModelCapabilities, 'efforts'>, saved: string | null | undefined): ModelRoutingEffort | null {
  return capabilities.efforts.find(level => level === saved) ?? null
}

/** A saved speed this model's route advertises, else null (standard). */
export function speedFor(capabilities: Pick<ModelCapabilities, 'speedModes'>, saved: string | null | undefined): ModelSpeedMode | null {
  return capabilities.speedModes.find(mode => mode === saved) ?? null
}

/** Capy's modes on a model: at most one of fast, ultrafast and pro; daybreak beside any of them. */
export interface ModelModes { fast: boolean; ultrafast: boolean; pro: boolean; daybreak: boolean }
export const NO_MODES: ModelModes = Object.freeze({ fast: false, ultrafast: false, pro: false, daybreak: false })

/**
 * Capy's `Qq`: the modes a setup keeps on a route. Pro wins and turns fast and ultrafast off; each mode stays only when
 * the route offers it. Without capabilities, the modes as asked (exclusion still applies).
 */
export function modesFor(capabilities: Pick<ModelCapabilities, 'speedModes' | 'pro' | 'daybreak'> | undefined, asked: Partial<ModelModes> | null | undefined): ModelModes {
  const pro = asked?.pro === true && (capabilities ? capabilities.pro === true : true)
  return {
    pro,
    fast: !pro && asked?.ultrafast !== true && asked?.fast === true && (capabilities ? capabilities.speedModes.includes('fast') : true),
    ultrafast: !pro && asked?.ultrafast === true && (capabilities ? capabilities.speedModes.includes('ultrafast') : true),
    daybreak: asked?.daybreak === true && (capabilities ? capabilities.daybreak !== undefined : true),
  }
}

/** More than one of fast, ultrafast and pro: no route can run that. */
export const modesConflict = (modes: Partial<ModelModes>) => [modes.fast, modes.ultrafast, modes.pro].filter(Boolean).length > 1

/**
 * A credential's or seat's Daybreak access, as Capy keeps it (`DaybreakAccess`): the models granted, and per tier
 * which ones. Recorded per API key (model_api_keys.daybreak) and per subscription (its catalogue's access programs).
 */
export interface DaybreakAccess {
  granted: string[]
  tiers?: DaybreakTier[]
  grants?: { tier: DaybreakTier; granted: string[] }[]
  /** When it was last checked (ISO time). */
  checkedAt?: string
}

/** Strictly parses stored DaybreakAccess JSONB, failing closed to undefined on malformed input. */
export function parseDaybreakAccess(raw: unknown): DaybreakAccess | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  if (!Array.isArray(value.granted) || value.granted.some(item => typeof item !== 'string' || !item.trim())) return undefined
  const granted = [...new Set(value.granted.map(item => item.trim()))]
  let tiers: DaybreakTier[] | undefined
  if (value.tiers !== undefined) {
    if (!Array.isArray(value.tiers) || value.tiers.some(t => t !== 'blue' && t !== 'red')) return undefined
    tiers = [...new Set(value.tiers as DaybreakTier[])]
  }
  let grants: { tier: DaybreakTier; granted: string[] }[] | undefined
  if (value.grants !== undefined) {
    if (!Array.isArray(value.grants)) return undefined
    const parsedGrants: { tier: DaybreakTier; granted: string[] }[] = []
    for (const entry of value.grants) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
      const rec = entry as Record<string, unknown>
      if (rec.tier !== 'blue' && rec.tier !== 'red') return undefined
      if (!Array.isArray(rec.granted) || rec.granted.some(item => typeof item !== 'string' || !item.trim())) return undefined
      parsedGrants.push({ tier: rec.tier, granted: [...new Set(rec.granted.map(item => item.trim()))] })
    }
    grants = parsedGrants
  }
  const checkedAt = typeof value.checkedAt === 'string' && value.checkedAt.trim() ? value.checkedAt.trim() : undefined
  return {
    granted,
    ...(tiers ? { tiers } : {}),
    ...(grants ? { grants } : {}),
    ...(checkedAt ? { checkedAt } : {}),
  }
}

/**
 * The tier `access` grants for `modelId`: a tier whose grant names the model, else (one list for all tiers) the first
 * listed tier in Codex's order, Blue before Red (openai/codex protocol/src/openai_models/access_programs.rs). None when
 * the model is not granted.
 */
export function daybreakTierFor(access: DaybreakAccess | null | undefined, modelId: string): DaybreakTier | undefined {
  if (!access) return undefined
  const named = (list: readonly string[]) => list.includes(modelId)
  for (const tier of DAYBREAK_TIERS) if (access.grants?.some(grant => grant.tier === tier && named(grant.granted))) return tier
  if (!named(access.granted)) return undefined
  return DAYBREAK_TIERS.find(tier => access.tiers?.includes(tier))
}


export function modesFromTier(tier: string | null | undefined): ModelModes {
  return { ...NO_MODES, fast: tier === 'fast', ultrafast: tier === 'ultrafast' }
}

export function tierForModes(modes: Pick<ModelModes, 'fast' | 'ultrafast'>): ModelServiceTier {
  return modes.ultrafast ? 'ultrafast' : modes.fast ? 'fast' : 'standard'
}

export function supportedModes(capabilities: ModelCapabilities | undefined, modes: ModelModes): boolean {
  return !modesConflict(modes) &&
    (!modes.pro || capabilities?.pro === true) &&
    (!modes.fast || capabilities?.speedModes.includes('fast') === true) &&
    (!modes.ultrafast || capabilities?.speedModes.includes('ultrafast') === true) &&
    (!modes.daybreak || capabilities?.daybreak !== undefined)
}
