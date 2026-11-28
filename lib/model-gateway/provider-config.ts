/** Provider metadata for LiteLLM routing and read-only credential/model discovery.
 * These addresses are never application model egress endpoints. */
import type { ApiKeyPreset, ApiKeyProtocol } from '../model-api-key-providers'
import type { LanguageModel } from 'ai'
import { MANAGED_WEB_SEARCH_MODELS } from '../model-catalog-metadata'

export type NativeWebSearchBackend = 'openai' | 'anthropic'
type Tools = Parameters<Extract<LanguageModel, { specificationVersion: 'v4' }>['doStream']>[0]['tools']

/** Native tools are explicit SDK declarations. Compatibility is checked at dispatch. */
export function nativeWebSearchBackendForTools(tools: Tools): NativeWebSearchBackend | undefined {
  const providerTools = tools?.filter(tool => tool.type === 'provider') ?? []
  const responses = providerTools.some(tool => tool.id === 'openai.web_search' || tool.id === 'openai.web_search_preview')
  const messages = providerTools.some(tool => tool.id === 'anthropic.web_search_20250305')
  if (responses && messages) throw new Error('model_native_web_search_unavailable')
  return responses ? 'openai' : messages ? 'anthropic' : undefined
}

/** Vercel Gateway allocation for search. The catalogue still supplies capabilities. */
export const MANAGED_WEB_SEARCH_MODEL = MANAGED_WEB_SEARCH_MODELS.responses
const MANAGED_SEARCH_ROUTES = new Map<string, { backend: 'openai'; alias: string } | { backend: 'anthropic' }>([
  [MANAGED_WEB_SEARCH_MODEL, { backend: 'openai', alias: 'mikka-native-responses/' + MANAGED_WEB_SEARCH_MODEL }],
  [MANAGED_WEB_SEARCH_MODELS.messages, { backend: 'anthropic' }],
])

export function managedSearchRoute(modelId: string) {
  return MANAGED_SEARCH_ROUTES.get(modelId)
}

interface PresetEndpoint {
  /**
   * Per protocol the official API speaks, the base URL its Agent talks to:
   * ANTHROPIC_BASE_URL for Claude Code, the model provider's base_url for
   * Codex (which Mikka runs on the Responses API). Anthropic first.
   */
  endpoints: Partial<Record<ApiKeyProtocol, string>>
  /** The read-only list the key is checked against when it is added. */
  modelsUrl: string
  modelsAuth: ApiKeyProtocol
  /** The OpenAI-compatible chat endpoint a bot chat (Mikka's own harness, R-05) talks to. */
  chatBaseUrl: string
  nativeWebSearch?: NativeWebSearchBackend
}

export const API_KEY_PRESET_ENDPOINTS: Record<ApiKeyPreset, PresetEndpoint> = {
  anthropic: { endpoints: { anthropic: 'https://api.anthropic.com' }, modelsUrl: 'https://api.anthropic.com/v1/models?limit=1000', modelsAuth: 'anthropic', chatBaseUrl: 'https://api.anthropic.com/v1', nativeWebSearch: 'anthropic' },
  openai: { endpoints: { openai: 'https://api.openai.com/v1' }, modelsUrl: 'https://api.openai.com/v1/models', modelsAuth: 'openai', chatBaseUrl: 'https://api.openai.com/v1', nativeWebSearch: 'openai' },
  // Both formats, from the providers' own docs: api-docs.deepseek.com (base_url OpenAI / Anthropic) and
  // platform.kimi.ai/docs/api/overview (OpenAI Chat Completions and Responses at /v1, Anthropic Messages at /anthropic).
  deepseek: { endpoints: { anthropic: 'https://api.deepseek.com/anthropic', openai: 'https://api.deepseek.com/v1' }, modelsUrl: 'https://api.deepseek.com/models', modelsAuth: 'openai', chatBaseUrl: 'https://api.deepseek.com/v1' },
  kimi: { endpoints: { anthropic: 'https://api.moonshot.cn/anthropic', openai: 'https://api.moonshot.cn/v1' }, modelsUrl: 'https://api.moonshot.cn/v1/models', modelsAuth: 'openai', chatBaseUrl: 'https://api.moonshot.cn/v1' },
}
