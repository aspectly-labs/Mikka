import { modelGatewayProtocolBody } from './protocol-fields.mjs'
/* The run's frozen model and server-owned credential reach only LiteLLM. */
import { managedLiteLlmModel } from './config'
import type { GatewayProtocol } from './usage'

export type GatewayOperation = 'messages' | 'count_tokens' | 'responses'

export interface GatewayUpstream {
  url: string
  masterKey: string
  /** Opened server-side for this request; never accepted from the CLI. */
  credential?: { key: string; provider: 'anthropic' | 'openai'; apiBase: string; chatCompletionsOnly?: boolean }
}

export interface UpstreamRequest { url: string; headers: Record<string, string>; body: Record<string, unknown> }

/** Client headers that carry protocol meaning. Authentication never passes through. */
const FORWARDED = ['anthropic-version', 'anthropic-beta', 'accept', 'openai-beta']

export function upstreamRequest(input: {
  protocol: GatewayProtocol
  operation: GatewayOperation
  /** The run's frozen model replaces whatever model the CLI asked for. */
  model: string
  body: Record<string, unknown>
  clientHeaders: Headers
  upstream: GatewayUpstream
  /** Server-verified serving speed tier frozen on the run, if any. */
  pro?: boolean
  serviceTier?: 'fast' | 'ultrafast'
  /** Server-verified Daybreak program (`access_programs.cyber`) frozen on the run, if any. */
  cyberAccessProgram?: 'daybreak_blue' | 'daybreak_red'
}): UpstreamRequest {
  if ((input.protocol === 'anthropic') !== (input.operation !== 'responses')) throw new Error('model_gateway_operation_mismatch')
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-litellm-api-key': `Bearer ${input.upstream.masterKey}` }
  for (const name of FORWARDED) {
    const value = input.clientHeaders.get(name)
    if (value) headers[name] = value
  }
  if (input.protocol === 'anthropic' && !headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01'
  const body = modelGatewayProtocolBody(input.protocol, input.body)
  // Speed mode is server-owned (frozen on the run after capability verification).
  // The CLI is not a trusted boundary: drop client service_tier/speed the same
  // way subscription-service.ts deletes payload.service_tier, then re-apply only
  // the grant. Leaving a client value when grant.serviceTier is unset let a
  // credits run request OpenAI priority while Mikka settled at catalogue rates.
  delete body.service_tier
  delete body.speed
  const openaiTarget = input.protocol === 'openai' || input.upstream.credential?.provider === 'openai'
  const allowAnthropicFast = input.serviceTier === 'fast' && !openaiTarget && input.operation !== 'count_tokens'
  if (headers['anthropic-beta'] && !allowAnthropicFast) {
    const filtered = headers['anthropic-beta'].split(',').map(part => part.trim()).filter(part => part && part !== 'fast-mode-2026-02-01')
    if (filtered.length) headers['anthropic-beta'] = filtered.join(',')
    else delete headers['anthropic-beta']
  }
  // The caller can request effort or summaries; mode belongs to the host's frozen grant.
  if (input.operation === 'responses' && body.reasoning && typeof body.reasoning === 'object') {
    const reasoning = { ...body.reasoning as Record<string, unknown> }
    delete reasoning.mode
    body.reasoning = reasoning
  }
  if (input.pro && input.operation === 'responses') {
    body.reasoning = { mode: 'pro' }
    delete body.service_tier
  } else if (input.serviceTier && input.operation !== 'count_tokens') {
    if (openaiTarget) {
      body.service_tier = input.serviceTier === 'ultrafast' ? 'ultrafast' : 'priority'
    } else if (allowAnthropicFast) {
      body.speed = 'fast'
      const beta = headers['anthropic-beta']
      if (!beta) headers['anthropic-beta'] = 'fast-mode-2026-02-01'
      else if (!beta.split(',').map(part => part.trim()).includes('fast-mode-2026-02-01')) headers['anthropic-beta'] = `${beta},fast-mode-2026-02-01`
    }
  }
  if (input.cyberAccessProgram && input.operation === 'responses' && input.upstream.credential?.provider === 'openai' && !input.upstream.credential.chatCompletionsOnly) {
    body.access_programs = { cyber: input.cyberAccessProgram }
  }
  body.model = managedLiteLlmModel(input.model)
  const credential = input.upstream.credential
  if (credential) Object.assign(body, {
    model: `${credential.provider}/${credential.chatCompletionsOnly ? 'chat_completions/' : ''}${input.model}`,
    custom_llm_provider: credential.provider,
    api_key: credential.key,
    api_base: credential.apiBase.replace(/\/+$/, ''),
    disable_fallbacks: true,
    num_retries: 0,
  })
  const path = input.protocol === 'anthropic'
    ? input.operation === 'count_tokens' ? '/v1/messages/count_tokens' : '/v1/messages'
    : '/v1/responses'
  return { url: input.upstream.url.replace(/\/+$/, '') + path, headers, body }
}
