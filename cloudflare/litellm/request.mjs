import { modelGatewayProtocolBody } from '../../lib/model-gateway/protocol-fields.mjs'
import { gatewayGenerationIdFromSearch } from '../../lib/model-gateway/gateway-generation-id.mjs'

const postPaths = new Set([
  '/v1/chat/completions', '/v1/decisions', '/v1/audio/transcriptions',
  '/v1/messages', '/v1/messages/count_tokens', '/v1/responses',
  '/v1/mikka/subscription/chat',
  '/v1/mikka/subscription/claude/messages', '/v1/mikka/subscription/claude/count_tokens',
  '/v1/mikka/subscription/codex/responses',
  '/v1/mikka/managed-search/haiku/stream/language-model',
  '/v1/mikka/managed-search/haiku/generate/language-model',
])

export function isLiteLlmRoute(method, path, search = '') {
  if (method === 'GET' && path === '/v1/mikka/gateway-generation') return !!gatewayGenerationIdFromSearch(search)
  return !search && (method === 'POST' && postPaths.has(path) || method === 'GET' && path === '/v1/mikka/catalog')
}

export function converterRequest(request) {
  const url = new URL(request.url)
  if (!isLiteLlmRoute(request.method, url.pathname, url.search)) return null
  return new Request('http://litellm' + url.pathname + url.search, request)
}

// The serving and rollback API send raw BYOK model names with bearer auth.
// Prepared APIs send explicit route names under x-litellm-api-key.
export async function converterCompatibilityRequest(request) {
  const path = new URL(request.url).pathname
  if (request.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens', '/v1/responses'].includes(path)
    || !request.headers.has('authorization') || request.headers.has('x-litellm-api-key')) return request
  const payload = await request.clone().json().catch(() => null)
  if (typeof payload?.model !== 'string' || !payload.model || typeof payload.api_key !== 'string' || !payload.api_key
    || typeof payload.api_base !== 'string' || !payload.api_base) return request
  const headers = new Headers(request.headers)
  headers.delete('content-length')
  const body = {
    ...modelGatewayProtocolBody(path === '/v1/responses' ? 'openai' : 'anthropic', payload),
    model: 'openai/chat_completions/' + payload.model,
    api_key: payload.api_key,
    api_base: payload.api_base,
    custom_llm_provider: 'openai',
    disable_fallbacks: true,
    num_retries: 0,
  }
  return new Request(request.url, { method: request.method, headers, signal: request.signal, body: JSON.stringify(body) })
}
