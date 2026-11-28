import 'server-only'
import { createLiteLLMModel } from './model-gateway/litellm-client'
import type { LanguageModel } from 'ai'
import { pool } from './db'
import { openApiKeyForChat, usableApiKeys } from './model-api-keys'
import { cyberAccessProgram as wireCyberProgram, daybreakTierFor, type CyberAccessProgram } from './model-capabilities'
import type { HostedApiKeySnapshot } from './subscription-model-snapshot'
import { withModelServiceTier } from './model-effort'
import type { ModelSpeedMode } from './model-routing'
import { observedModel } from './tracing/ai'
import { API_KEY_PRESET_ENDPOINTS, nativeWebSearchBackendForTools, type NativeWebSearchBackend } from './model-gateway/provider-config'

type V4Model = Extract<LanguageModel, { specificationVersion: 'v4' }>

export async function apiKeyNativeSearchBackend(frozen: HostedApiKeySnapshot): Promise<NativeWebSearchBackend | undefined> {
  const [key] = await usableApiKeys(pool, frozen.ownerId, frozen.workspaceId, frozen.keyId)
  if (!key || key.provider === 'custom' || !key.models.includes(frozen.modelId)) return undefined
  const backend = API_KEY_PRESET_ENDPOINTS[key.provider].nativeWebSearch
  if (!backend || (backend === 'openai' && !key.responsesApi)) return undefined
  const [{ catalogIdFor }, { modelCatalog }] = await Promise.all([import('./model-catalog'), import('./model-catalog-server')])
  const id = catalogIdFor(frozen.modelId)
  const model = (await modelCatalog()).find(entry => entry.id === id && entry.vendor === backend)
  return model?.tags.includes('web-search') ? backend : undefined
}

async function open(frozen: HostedApiKeySnapshot, serviceTier?: ModelSpeedMode, pro = false, cyberAccessProgram?: CyberAccessProgram): Promise<V4Model> {
  const { apiKey, baseUrl, provider, modelSpeedModes, daybreak } = await openApiKeyForChat(pool, frozen.ownerId, frozen.workspaceId, frozen.keyId)
  if (pro && provider !== 'openai') throw new Error('model_pro_unavailable')
  if (cyberAccessProgram) {
    const grantedTier = provider === 'openai' ? daybreakTierFor(daybreak, frozen.modelId) : undefined
    if (!grantedTier || wireCyberProgram(grantedTier) !== cyberAccessProgram) throw new Error('model_daybreak_unavailable')
  }
  const model = createLiteLLMModel(frozen.modelId, {
    user: frozen.workspaceId,
    ...(pro ? { pro } : {}),
    ...(cyberAccessProgram ? { cyberAccessProgram } : {}),
    credential: {
      apiKey, baseUrl, provider: provider === 'anthropic' ? 'anthropic' : 'openai', modelId: frozen.modelId,
      ...(provider === 'openai' ? { nativeResponses: true } : {}),
      ...(provider === 'anthropic' ? { nativeMessages: true } : {}),
    },
  })
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
export async function resolveApiKeyChatModel(frozen: HostedApiKeySnapshot, serviceTier?: ModelSpeedMode, pro = false, cyberAccessProgram?: CyberAccessProgram): Promise<LanguageModel> {
  const first = await open(frozen, serviceTier, pro, cyberAccessProgram)
  return observedModel(new Proxy(first, { get(target, property) {
    const member = Reflect.get(target, property, target)
    if (property === 'doStream' || property === 'doGenerate') {
      return async (...args: unknown[]) => {
        const current = await open(frozen, serviceTier, pro, cyberAccessProgram)
        const { tools, abortSignal } = args[0] as Parameters<V4Model['doStream']>[0]
        const backend = nativeWebSearchBackendForTools(tools)
        if (backend) {
          if (backend !== await apiKeyNativeSearchBackend(frozen)) throw new Error('model_native_web_search_unavailable')
          const { admitWebRequest } = await import('./search/rate-limit')
          if (!await admitWebRequest(pool, frozen.ownerId, abortSignal)) throw new Error('web_search_rate_limited')
        }
        return Reflect.apply(Reflect.get(current, property, current) as (...a: unknown[]) => unknown, current, args)
      }
    }
    return member
  } }), { modelId: frozen.modelId, userId: frozen.ownerId, route: 'api_key', operation: frozen.coordinator ? 'coordinator' : 'bot' })
}
