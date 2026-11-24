import 'server-only'
import { createLiteLLMModel } from './model-gateway/litellm-client'
import type { LanguageModel } from 'ai'
import { pool } from './db'
import { openApiKeyForChat } from './model-api-keys'
import type { HostedApiKeySnapshot } from './subscription-model-snapshot'
import { withModelServiceTier } from './model-effort'
import type { ModelSpeedMode } from './model-routing'
import { observedModel } from './tracing/ai'

type V4Model = Extract<LanguageModel, { specificationVersion: 'v4' }>

async function open(frozen: HostedApiKeySnapshot, serviceTier?: ModelSpeedMode): Promise<V4Model> {
  const { apiKey, baseUrl, provider, modelSpeedModes } = await openApiKeyForChat(pool, frozen.ownerId, frozen.workspaceId, frozen.keyId)
  const model = createLiteLLMModel(frozen.modelId, { user: frozen.workspaceId, credential: { apiKey, baseUrl, provider: provider === 'anthropic' ? 'anthropic' : 'openai', modelId: frozen.modelId } })
  if (typeof model === 'string' || model.specificationVersion !== 'v4') throw new Error('subscription_model_unavailable')
  if (!serviceTier) return model
  // Verify server-advertised speed support against the exact authorized key and model before encoding the tier.
  const advertised = modelSpeedModes && Object.hasOwn(modelSpeedModes, frozen.modelId) ? modelSpeedModes[frozen.modelId] : undefined
  let supported: readonly ModelSpeedMode[] = advertised ?? []
  if (advertised === undefined) {
    const { gatewayLiteLlm } = await import('./model-gateway/config')
    if (gatewayLiteLlm()) {
      const directMatch = provider === 'openai' || provider === 'anthropic' || (provider === 'custom' && frozen.modelId.includes('/'))
      if (directMatch) {
        const { creditsModelSpeedModes } = await import('./model-order')
        supported = await creditsModelSpeedModes(frozen.modelId)
      }
    }
  }
  return supported.includes(serviceTier) ? withModelServiceTier(model, serviceTier) : model
}

/**
 * A bot chat frozen on an API key model (C22). The key is opened again for
 * every LiteLLM call, so deleting it or withdrawing its share stops the chat at
 * its next call instead of switching to another credential (orchestration.md § 2).
 * The provider bills the key's owner; Mikka charges no credits (§ 7).
 */
export async function resolveApiKeyChatModel(frozen: HostedApiKeySnapshot, serviceTier?: ModelSpeedMode): Promise<LanguageModel> {
  const first = await open(frozen, serviceTier)
  return observedModel(new Proxy(first, { get(target, property) {
    const member = Reflect.get(target, property, target)
    if (property === 'doStream' || property === 'doGenerate') {
      return async (...args: unknown[]) => {
        const current = await open(frozen, serviceTier)
        return Reflect.apply(Reflect.get(current, property, current) as (...a: unknown[]) => unknown, current, args)
      }
    }
    return member
  } }), { modelId: frozen.modelId, userId: frozen.ownerId, route: 'api_key', operation: frozen.coordinator ? 'coordinator' : 'bot' })
}
