import type { LanguageModel } from 'ai'
import { supportedModelEfforts, type ModelRoutingEffort, type ModelSpeedMode } from './model-routing'

type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
type CallOptions = Parameters<Model['doStream']>[0]

/** The harness family whose effort catalogue a chat model belongs to (lib/model-routing.ts). */
function familyOf(modelId: string): 'claude_code' | 'codex' {
  return /(^|\/)(gpt|o\d)/i.test(modelId) ? 'codex' : 'claude_code'
}

/** The provider options that carry a reasoning effort: OpenAI's and an OpenAI-compatible route's `reasoningEffort`, Anthropic's `effort`. */
export function effortProviderOptions(effort: ModelRoutingEffort): NonNullable<CallOptions['providerOptions']> {
  return { openai: { reasoningEffort: effort }, openaiCompatible: { reasoningEffort: effort }, anthropic: { effort } }
}

/**
 * The Bot's chat model with its saved reasoning effort (bot_model_choices.effort)
 * on every call. The effort was checked against the provider's own catalogue when
 * the turn froze its model (lib/bot-model-selection.ts, lib/model-capabilities.ts).
 * A model Mikka's built-in list knows is checked again here; one it does not know
 * keeps the frozen effort. No effort gets the model unchanged: the provider's default.
 */
export function withModelEffort(model: Model, effort: ModelRoutingEffort | null | undefined): Model {
  const id = model.modelId.split('/').pop() ?? model.modelId
  if (!effort) return model
  const builtin = supportedModelEfforts(id, familyOf(id))
  if (builtin.length && !builtin.includes(effort)) return model
  const extra = effortProviderOptions(effort)
  const merge = (options: CallOptions): CallOptions => {
    const providerOptions = { ...options.providerOptions }
    for (const [key, value] of Object.entries(extra)) providerOptions[key] = { ...value, ...providerOptions[key] }
    return { ...options, providerOptions }
  }
  return {
    specificationVersion: 'v4', provider: model.provider, modelId: model.modelId, supportedUrls: model.supportedUrls,
    doStream: options => model.doStream(merge(options)),
    doGenerate: options => model.doGenerate(merge(options)),
  }
}

/**
 * Applies a server-verified serving speed tier (`fast` / `ultrafast`) to a
 * hosted/gateway language model's providerOptions. Callers must verify support
 * against real server capability metadata before calling this.
 */
export function withModelServiceTier(model: Model, serviceTier: ModelSpeedMode | null | undefined): Model {
  if (!serviceTier) return model
  const codexTier = serviceTier === 'ultrafast' ? 'ultrafast' : 'priority'
  const anthropicFast = serviceTier === 'fast' && /(^|\/)claude/i.test(model.modelId)
  const extra: NonNullable<CallOptions['providerOptions']> = {
    openai: { serviceTier: codexTier },
    openaiCompatible: { service_tier: codexTier },
    ...(serviceTier === 'fast' ? { anthropic: { speed: 'fast' } } : {}),
  }
  const merge = (options: CallOptions): CallOptions => {
    const providerOptions = { ...options.providerOptions }
    for (const [key, value] of Object.entries(extra)) providerOptions[key] = { ...value, ...providerOptions[key] }
    if (!anthropicFast) return { ...options, providerOptions }
    const existing = options.headers?.['anthropic-beta']
    const beta = !existing
      ? 'fast-mode-2026-02-01'
      : existing.split(',').map(part => part.trim()).includes('fast-mode-2026-02-01')
        ? existing
        : `${existing},fast-mode-2026-02-01`
    return { ...options, providerOptions, headers: { ...options.headers, 'anthropic-beta': beta } }
  }
  return {
    specificationVersion: 'v4', provider: model.provider, modelId: model.modelId, supportedUrls: model.supportedUrls,
    doStream: options => model.doStream(merge(options)),
    doGenerate: options => model.doGenerate(merge(options)),
  }
}
