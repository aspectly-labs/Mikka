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
const FAST_ONLY = Object.freeze<ModelSpeedMode[]>(['fast'])
const FAST_AND_ULTRAFAST = Object.freeze<ModelSpeedMode[]>(['fast', 'ultrafast'])

/**
 * Serving speed modes a candidate model can offer in the ModelPicker (Capy
 * Fast mode / Ultrafast). When an account catalogue explicitly advertises
 * `prioritySupported === false`, no speed tier is offered.
 */
export function supportedModelSpeedModes(
  model: string,
  harness: OrderHarness,
  options: { provider?: string; prioritySupported?: boolean } = {},
): readonly ModelSpeedMode[] {
  if (options.prioritySupported === false) return NO_SPEEDS
  const lower = model.trim().toLowerCase()
  const bare = lower.includes('/') ? lower.slice(lower.indexOf('/') + 1) : lower
  const isOpenAiFamily = options.provider === 'codex' || options.provider === 'openai'
    || lower.startsWith('openai/') || /^gpt-(?:5|6)|^o[345]/.test(bare)
  if (harness === 'codex' && (options.prioritySupported === true || isOpenAiFamily)) {
    return FAST_AND_ULTRAFAST
  }
  if (harness === 'claude_code' && (bare.startsWith('claude-opus-') || bare.startsWith('claude-fable-'))) {
    return FAST_ONLY
  }
  return NO_SPEEDS
}
