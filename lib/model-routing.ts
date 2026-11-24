/** Automatic model routing was removed (decision 2026-11-15-1630): a task
 * takes the model someone names or the dispatching chat's own. What remains
 * is read by runs frozen before then, and the model effort catalogue. */
import type { OrderHarness } from './model-order-plan'

export const MODEL_ROUTING_TIERS = ['light', 'standard', 'strongest'] as const
/** Version-1 snapshots only: frozen runs from before the tier judgement. */
export const MODEL_ROUTING_DIFFICULTIES = ['easy', 'medium', 'hard'] as const
export const MODEL_ROUTING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const MODEL_SERVICE_TIERS = ['standard', 'fast', 'ultrafast'] as const
export const MODEL_SPEED_MODES = ['fast', 'ultrafast'] as const
/** difficulty_fit keeps its frozen ID: in version 2 it means "fits the judged tier". */
export const MODEL_ROUTING_REASONS = ['difficulty_fit', 'list_order', 'low_confidence', 'decision_unavailable', 'invalid_answer', 'no_selection', 'escalated'] as const
export type ModelRoutingTier = typeof MODEL_ROUTING_TIERS[number]
export type ModelRoutingDifficulty = typeof MODEL_ROUTING_DIFFICULTIES[number]
export type ModelRoutingEffort = typeof MODEL_ROUTING_EFFORTS[number]
export type ModelServiceTier = typeof MODEL_SERVICE_TIERS[number]
export type ModelSpeedMode = typeof MODEL_SPEED_MODES[number]
export type RoutingReason = typeof MODEL_ROUTING_REASONS[number]
export type ModelRoutingReason = RoutingReason

interface FrozenRoutingFields {
  model: string
  harness: OrderHarness
  tier: ModelRoutingTier
  effort?: ModelRoutingEffort
  reason: RoutingReason
  previousModel?: string
}
/** Historical: frozen by the earlier difficulty question. Read, never written. */
export interface ModelRoutingSnapshotV1 extends FrozenRoutingFields { version: 1; difficulty: ModelRoutingDifficulty | 'unknown' }
/** Frozen with the run. `required` is the judged model tier; an unavailable
 * or uncertain Decision records 'unknown', never an invented tier. */
export interface ModelRoutingSnapshot extends FrozenRoutingFields { version: 2; required: ModelRoutingTier | 'unknown' }
export type FrozenModelRoutingSnapshot = ModelRoutingSnapshotV1 | ModelRoutingSnapshot

/** Update exact IDs here when models change. Unlisted models stay standard. */
export const MODEL_TIERS: Readonly<Record<string, ModelRoutingTier>> = Object.freeze({
  'claude-haiku-5-5': 'light',
  'gpt-6-luna': 'light',
  'gpt-5.6-luna': 'light',
  'deepseek-flash': 'light',
  'claude-sonnet-5-5': 'standard',
  'gpt-6-sol': 'standard',
  'gpt-5.6-sol': 'standard',
  'gpt-5.6-terra': 'standard',
  'gpt-5.5': 'standard',
  'claude-opus-5-5': 'strongest',
  'claude-fable-5-1': 'strongest',
  'gpt-6.1-sol': 'strongest',
  'gpt-6-astra': 'strongest',
})
export function modelTier(model: string): ModelRoutingTier {
  return Object.hasOwn(MODEL_TIERS, model) ? MODEL_TIERS[model] : 'standard'
}

// The native catalogues are retained in packages/daemon/test/fixtures:
// claude-code-2.1.309-initialize.json and codex-0.163.0-model-list.json.
// Only their supported levels accepted by the current run protocol are offered;
// Codex's ultra is deliberately absent until that protocol can carry it.
const NATIVE_EFFORTS = Object.freeze([...MODEL_ROUTING_EFFORTS])
const GPT_55_EFFORTS = Object.freeze<ModelRoutingEffort[]>(['low', 'medium', 'high', 'xhigh'])
const NO_EFFORTS = Object.freeze<ModelRoutingEffort[]>([])
const EFFORT_MODELS: Readonly<Record<OrderHarness, Readonly<Record<string, readonly ModelRoutingEffort[]>>>> = {
  claude_code: {
    'claude-haiku-5-5': NATIVE_EFFORTS, 'claude-sonnet-5-5': NATIVE_EFFORTS,
    'claude-opus-5-5': NATIVE_EFFORTS, 'claude-fable-5-1': NATIVE_EFFORTS,
  },
  codex: {
    'gpt-6.1-sol': NATIVE_EFFORTS, 'gpt-6-astra': NATIVE_EFFORTS,
    'gpt-6-sol': NATIVE_EFFORTS, 'gpt-6-luna': NATIVE_EFFORTS,
    'gpt-5.6-sol': NATIVE_EFFORTS, 'gpt-5.6-terra': NATIVE_EFFORTS,
    'gpt-5.6-luna': NATIVE_EFFORTS, 'gpt-5.5': GPT_55_EFFORTS,
  },
}
export function supportedModelEfforts(model: string, harness: OrderHarness): readonly ModelRoutingEffort[] {
  const models = EFFORT_MODELS[harness]
  return Object.hasOwn(models, model) ? models[model] : NO_EFFORTS
}

const NO_SPEEDS = Object.freeze<ModelSpeedMode[]>([])

function normalizeSpeedModes(modes: Iterable<ModelSpeedMode>): readonly ModelSpeedMode[] {
  const seen = new Set<ModelSpeedMode>()
  for (const mode of modes) {
    if (mode === 'fast' || mode === 'ultrafast') seen.add(mode)
  }
  const ordered: ModelSpeedMode[] = []
  if (seen.has('fast')) ordered.push('fast')
  if (seen.has('ultrafast')) ordered.push('ultrafast')
  return ordered.length ? ordered : NO_SPEEDS
}

/**
 * Extracts real server-advertised speed capabilities from a provider/gateway
 * model descriptor (`/models`, `/backend-api/codex/models`, or LiteLLM
 * `/v1/mikka/catalog`). Returns `undefined` when the endpoint reported no
 * speed-capability fields at all (distinct from an explicit empty array `[]`).
 * Never infers capabilities from model names.
 */
export function extractProviderSpeedModes(raw: unknown): readonly ModelSpeedMode[] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const entry = raw as Record<string, unknown>
  const found: ModelSpeedMode[] = []
  let hasSignal = false

  // 1. Codex / OpenAI-style `service_tiers` (`[{"id":"priority"},{"id":"ultrafast"}]` or string[])
  const tiers = entry.service_tiers ?? entry.serviceTiers
  if (Array.isArray(tiers)) {
    let valid = true
    for (const tier of tiers) {
      if (typeof tier === 'string' && tier.trim()) {
        if (tier === 'priority' || tier === 'fast') found.push('fast')
        else if (tier === 'ultrafast') found.push('ultrafast')
      } else if (tier && typeof tier === 'object' && !Array.isArray(tier) && typeof (tier as { id?: unknown }).id === 'string' && (tier as { id: string }).id) {
        const id = (tier as { id: string }).id
        if (id === 'priority' || id === 'fast') found.push('fast')
        else if (id === 'ultrafast') found.push('ultrafast')
      } else {
        valid = false
        break
      }
    }
    if (valid) hasSignal = true
  }

  // 2. Explicit `speed_modes` / `speedModes` array
  const speedList = entry.speed_modes ?? entry.speedModes
  if (Array.isArray(speedList)) {
    hasSignal = true
    for (const item of speedList) {
      if (item === 'fast' || item === 'priority') found.push('fast')
      else if (item === 'ultrafast') found.push('ultrafast')
    }
  }

  // 3. Explicit boolean flags (`supports_fast_mode`, `supportsFastMode`, `supports_ultrafast`, `capabilities.fast_mode.supported`)
  const supportsFast = entry.supports_fast_mode ?? entry.supportsFastMode
  if (typeof supportsFast === 'boolean') {
    hasSignal = true
    if (supportsFast) found.push('fast')
  }
  const supportsUltrafast = entry.supports_ultrafast ?? entry.supportsUltrafast
  if (typeof supportsUltrafast === 'boolean') {
    hasSignal = true
    if (supportsUltrafast) found.push('ultrafast')
  }
  if (entry.capabilities && typeof entry.capabilities === 'object' && !Array.isArray(entry.capabilities)) {
    const caps = entry.capabilities as Record<string, unknown>
    const fm = caps.fast_mode
    if (fm && typeof fm === 'object' && typeof (fm as { supported?: unknown }).supported === 'boolean') {
      hasSignal = true
      if ((fm as { supported: boolean }).supported) found.push('fast')
    }
    const uf = caps.ultrafast
    if (uf && typeof uf === 'object' && typeof (uf as { supported?: unknown }).supported === 'boolean') {
      hasSignal = true
      if ((uf as { supported: boolean }).supported) found.push('ultrafast')
    }
  }

  // 4. Gateway / LiteLLM catalogue `tags` (`"fast"`, `"ultrafast"`)
  if (Array.isArray(entry.tags)) {
    hasSignal = true
    for (const tag of entry.tags) {
      if (tag === 'fast') found.push('fast')
      else if (tag === 'ultrafast') found.push('ultrafast')
    }
  }

  return hasSignal ? normalizeSpeedModes(found) : undefined
}

/**
 * Resolves speed modes strictly from server-reported evidence (subscription
 * `modelCatalog`, API-key `/models` capabilities, or live Gateway catalogue).
 * Never hardcodes or guesses capabilities from model names.
 */
export function resolveSpeedModesFromEvidence(evidence: {
  advertised?: readonly ModelSpeedMode[] | null
  prioritySupported?: boolean
  ultrafastSupported?: boolean
  fastSupported?: boolean
  catalogSpeedModes?: readonly ModelSpeedMode[] | null
  catalogTags?: readonly string[] | null
}): readonly ModelSpeedMode[] {
  if (evidence.advertised !== undefined && evidence.advertised !== null) {
    return normalizeSpeedModes(evidence.advertised)
  }
  const hasExplicitFlags = typeof evidence.prioritySupported === 'boolean'
    || typeof evidence.ultrafastSupported === 'boolean'
    || typeof evidence.fastSupported === 'boolean'
  if (hasExplicitFlags) {
    const modes: ModelSpeedMode[] = []
    if (evidence.prioritySupported === true || evidence.fastSupported === true) modes.push('fast')
    if (evidence.ultrafastSupported === true) modes.push('ultrafast')
    return normalizeSpeedModes(modes)
  }
  if (evidence.catalogSpeedModes && evidence.catalogSpeedModes.length) {
    return normalizeSpeedModes(evidence.catalogSpeedModes)
  }
  if (evidence.catalogTags && evidence.catalogTags.length) {
    const modes: ModelSpeedMode[] = []
    if (evidence.catalogTags.includes('fast')) modes.push('fast')
    if (evidence.catalogTags.includes('ultrafast')) modes.push('ultrafast')
    return normalizeSpeedModes(modes)
  }
  return NO_SPEEDS
}
