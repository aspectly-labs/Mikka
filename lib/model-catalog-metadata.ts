/**
 * Single static model-metadata boundary (Issue #3342, G4).
 *
 * Centralizes every frozen historical model identifier, native CLI tier/effort
 * table, and gateway provider default alias in one pure, client-safe catalog
 * metadata module so runtime routing, governance, coordinator, and factory
 * modules never hardcode upstream model IDs directly.
 *
 * Canonical entries are keyed by `vendor/model` (matching `lib/model-catalog.ts`);
 * native CLI lookup tables derive the bare runtime identifier from the canonical key.
 */
import type { OrderHarness } from './model-order-plan'
import type { ModelRoutingEffort, ModelRoutingTier } from './model-routing'

interface NativeModelMetadataEntry {
  readonly tier: ModelRoutingTier
  readonly harness?: OrderHarness
  readonly efforts?: readonly ModelRoutingEffort[]
}

// Native CLI capability tables retained in packages/daemon/test/fixtures:
// claude-code-2.1.309-initialize.json and codex-0.163.0-model-list.json.
// Only levels accepted by the current run protocol are offered; Codex's ultra
// is deliberately absent until that protocol can carry it.
const ALL_NATIVE_EFFORTS = Object.freeze<ModelRoutingEffort[]>(['low', 'medium', 'high', 'xhigh', 'max'])
const EXTENDED_REASONING_EFFORTS = Object.freeze<ModelRoutingEffort[]>(['low', 'medium', 'high', 'xhigh'])
const NO_EFFORTS = Object.freeze<ModelRoutingEffort[]>([])

const NATIVE_MODEL_METADATA: Readonly<Record<string, NativeModelMetadataEntry>> = Object.freeze({
  'anthropic/claude-haiku-5-5': { tier: 'light', harness: 'claude_code', efforts: ALL_NATIVE_EFFORTS },
  'openai/gpt-6-luna': { tier: 'light', harness: 'codex', efforts: ALL_NATIVE_EFFORTS },
  'openai/gpt-5.6-luna': { tier: 'light', harness: 'codex', efforts: ALL_NATIVE_EFFORTS },
  'deepseek/deepseek-flash': { tier: 'light' },
  'anthropic/claude-sonnet-5-5': { tier: 'standard', harness: 'claude_code', efforts: ALL_NATIVE_EFFORTS },
  'openai/gpt-6-sol': { tier: 'standard', harness: 'codex', efforts: ALL_NATIVE_EFFORTS },
  'openai/gpt-5.6-sol': { tier: 'standard', harness: 'codex', efforts: ALL_NATIVE_EFFORTS },
  'openai/gpt-5.6-terra': { tier: 'standard', harness: 'codex', efforts: ALL_NATIVE_EFFORTS },
  'openai/gpt-5.5': { tier: 'standard', harness: 'codex', efforts: EXTENDED_REASONING_EFFORTS },
  'anthropic/claude-opus-5-5': { tier: 'strongest', harness: 'claude_code', efforts: ALL_NATIVE_EFFORTS },
  'anthropic/claude-fable-5-1': { tier: 'strongest', harness: 'claude_code', efforts: ALL_NATIVE_EFFORTS },
  'openai/gpt-6.1-sol': { tier: 'strongest', harness: 'codex', efforts: ALL_NATIVE_EFFORTS },
  'openai/gpt-6-astra': { tier: 'strongest', harness: 'codex', efforts: ALL_NATIVE_EFFORTS },
})

function nativeModelId(canonicalId: string): string {
  const slash = canonicalId.indexOf('/')
  return slash >= 0 ? canonicalId.slice(slash + 1) : canonicalId
}

const builtTiers: Record<string, ModelRoutingTier> = {}
const builtEfforts: Record<OrderHarness, Record<string, readonly ModelRoutingEffort[]>> = {
  claude_code: {},
  codex: {},
}

for (const [canonicalId, entry] of Object.entries(NATIVE_MODEL_METADATA)) {
  const runtimeId = nativeModelId(canonicalId)
  builtTiers[runtimeId] = entry.tier
  if (entry.harness && entry.efforts) {
    builtEfforts[entry.harness][runtimeId] = entry.efforts
  }
}

/** Exact tier metadata for reported native CLI models. Unlisted models remain `standard`. */
export const CATALOG_MODEL_TIERS: Readonly<Record<string, ModelRoutingTier>> = Object.freeze(builtTiers)

/** Exact supported reasoning efforts per native CLI harness and reported model ID. */
export const CATALOG_EFFORT_MODELS: Readonly<Record<OrderHarness, Readonly<Record<string, readonly ModelRoutingEffort[]>>>> = Object.freeze({
  claude_code: Object.freeze(builtEfforts.claude_code),
  codex: Object.freeze(builtEfforts.codex),
})

export function catalogModelTier(model: string): ModelRoutingTier {
  return Object.hasOwn(CATALOG_MODEL_TIERS, model) ? CATALOG_MODEL_TIERS[model] : 'standard'
}

export function catalogSupportedModelEfforts(model: string, harness: OrderHarness): readonly ModelRoutingEffort[] {
  const models = CATALOG_EFFORT_MODELS[harness]
  return Object.hasOwn(models, model) ? models[model] : NO_EFFORTS
}

/** Hosted upstream default model aliases for registered Eve Software Factory providers (#3082). */
export const EVE_FACTORY_PROVIDER_DEFAULT_MODELS = Object.freeze({
  'vercel-ai-gateway': 'vercel-ai-gateway/anthropic/claude-sonnet-4.5',
  'openrouter': 'openrouter/anthropic/claude-sonnet-4.5',
  'bedrock': 'bedrock/anthropic.claude-sonnet-4-5',
  'vertex-ai': 'vertex_ai/claude-sonnet-4-5',
} as const)

export type EveFactoryProviderId = keyof typeof EVE_FACTORY_PROVIDER_DEFAULT_MODELS

export function defaultEveFactoryModelForProvider(provider: EveFactoryProviderId): string {
  return EVE_FACTORY_PROVIDER_DEFAULT_MODELS[provider]
}

/** Historical receipt identifier retained for persisted decision receipts; new calls use `mikka-decision`. */
export const LEGACY_DECISION_MODEL = 'openai/gpt-6-luna-decisions' as const

/** Historical snapshot identifier retained for already-issued write-planning runs; new calls use `mikka-planning`. */
export const LEGACY_WRITE_PLANNING_SNAPSHOT = 'openai/gpt-6-luna' as const

/**
 * Models supporting `reasoning.mode: "pro"` on Mikka Credits and OpenAI BYOK keys
 * (never on subscription seats). Keys match `modelKeyOf` (`vendor/bare`).
 */
export const CATALOG_PRO_MODELS: ReadonlySet<string> = new Set([
  'openai/gpt-6.2-astra', 'openai/gpt-6-astra', 'openai/gpt-6.2-sol', 'openai/gpt-6.1-sol', 'openai/gpt-6-sol',
  'openai/gpt-6-luna', 'openai/gpt-6.1-terra', 'openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna',
])

const PROVIDER_LABS: Readonly<Record<string, string>> = Object.freeze({
  claude: 'anthropic',
  anthropic: 'anthropic',
  codex: 'openai',
  openai: 'openai',
})

/** Canonical vendor/lab name for a known subscription or API-key provider identifier. */
export function catalogProviderLab(provider: string): string | undefined {
  return Object.hasOwn(PROVIDER_LABS, provider) ? PROVIDER_LABS[provider] : undefined
}

/** Native CLI harness family for a known subscription or API-key provider identifier. */
export function catalogProviderHarness(provider?: string): OrderHarness | undefined {
  if (provider === 'codex' || provider === 'openai') return 'codex'
  if (provider === 'claude' || provider === 'anthropic') return 'claude_code'
  return undefined
}

/** Whether a BYOK provider supports OpenAI-native Responses modes (Pro / Daybreak). */
export function providerSupportsOpenAIModes(provider: string): boolean {
  return provider === 'openai'
}
