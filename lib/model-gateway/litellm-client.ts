import 'server-only'

import { createAnthropic } from '@ai-sdk/anthropic'
import { createGateway } from '@ai-sdk/gateway'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { wrapLanguageModel, type LanguageModel } from 'ai'
import { setTimeout } from 'node:timers/promises'
import { gatewayLiteLlm, managedLiteLlmModel } from './config'
import { modelKeyOf, PRO_MODELS } from '../model-capabilities'
import { isGatewayGenerationId } from './gateway-generation-id.mjs'
import { decodeHostedCallId } from './hosted-call-id.mjs'
import { managedSearchRoute, nativeWebSearchBackendForTools, type NativeWebSearchBackend } from './provider-config'

type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
type ModelCallOptions = Parameters<Model['doStream']>[0]
type ModelStreamResult = Awaited<ReturnType<Model['doStream']>>

type Credential = {
  provider: 'anthropic' | 'openai'
  apiKey: string
  baseUrl: string
  modelId: string
  nativeResponses?: true
  nativeMessages?: true
}

function managedHaikuModel(config: ReturnType<typeof connection>, modelId: string, callId?: string) {
  const baseURL = config.baseURL + '/mikka/managed-search/haiku'
  return createGateway({ baseURL, apiKey: config.apiKey, async fetch(_input, init) {
    const stream = new Headers(init?.headers).get('ai-language-model-streaming') === 'true'
    const path = stream ? '/stream/language-model' : '/generate/language-model'
    const headers = new Headers({ 'authorization': 'Bearer ' + config.apiKey, 'content-type': 'application/json' })
    if (callId) headers.set('x-litellm-call-id', callId)
    const body = JSON.parse(String(init?.body))
    delete body.headers
    delete body.providerOptions
    const response = await fetch(baseURL + path, {
      method: 'POST', signal: init?.signal, headers, redirect: 'error',
      body: JSON.stringify({ custom_body: body, ...(stream && { stream }) }),
    })
    // The Gateway generation ID arrives in SDK metadata. LiteLLM's own ID
    // and streaming price are unrelated to the Vercel generation receipt.
    const safeHeaders = new Headers(response.headers)
    safeHeaders.delete('x-litellm-call-id')
    safeHeaders.delete('x-litellm-response-cost')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: safeHeaders })
  } }).languageModel(modelId)
}

function gatewayGenerationId(metadata: unknown) {
  const id = (metadata as { gateway?: { generationId?: unknown } } | undefined)?.gateway?.generationId
  return isGatewayGenerationId(id) ? id as string : undefined
}

async function gatewayGenerationCost(config: ReturnType<typeof connection>, modelId: string, generationId: string | undefined, abortSignal?: AbortSignal) {
  if (!generationId) return null
  const timeout = AbortSignal.timeout(4_000)
  const signal = abortSignal ? AbortSignal.any([timeout, abortSignal]) : timeout
  try {
    // The receipt endpoint can return 404 while a completed generation is being recorded.
    for (const delay of [0, 100, 250, 500, 1_000]) {
      signal.throwIfAborted()
      if (delay) await setTimeout(delay, undefined, { signal })
      const response = await fetch(config.baseURL + '/mikka/gateway-generation?id=' + generationId, {
        headers: { authorization: 'Bearer ' + config.apiKey }, signal, redirect: 'error', cache: 'no-store',
      })
      if (response.ok) {
        const data = (await response.json())?.data
        return data?.id === generationId && data.model === modelId && data.is_byok === false ? toMicros(data.total_cost) : null
      }
      await response.body?.cancel()
      if (response.status !== 404) return null
    }
  } catch {
    // Keep the ID on the unknown receipt if the lookup failed or was interrupted.
  }
  return null
}

function managedHaikuStream(result: ModelStreamResult, lookupCost: (id: string | undefined, signal: AbortSignal) => Promise<number | null>) {
  const reader = result.stream.getReader()
  const cancellation = new AbortController()
  let generationId: string | undefined
  let conflictingId = false
  return {
    ...result,
    stream: new ReadableStream({
      async pull(controller) {
        // Skip raw diagnostics while continuing to read until a protocol event arrives.
        while (!cancellation.signal.aborted) {
          const { value: part, done } = await reader.read()
          if (cancellation.signal.aborted) return
          if (done) return controller.close()
          if (part.type === 'raw') continue
          const metadata = 'providerMetadata' in part ? part.providerMetadata : undefined
          const errorId = part.type === 'error' ? (part.error as { generationId?: unknown } | undefined)?.generationId : undefined
          const observed = gatewayGenerationId(metadata) ?? (typeof errorId === 'string' && isGatewayGenerationId(errorId) ? errorId : undefined)
          const first = !generationId && observed
          if (generationId && observed && generationId !== observed) conflictingId = true
          generationId ??= observed
          if (part.type === 'finish') {
            const costMicros = conflictingId ? null : await lookupCost(generationId, cancellation.signal)
            if (cancellation.signal.aborted) return
            controller.enqueue({ ...part, providerMetadata: { ...part.providerMetadata, liteLLM: { ...(generationId && { generationId }), costMicros } } })
            return
          }
          controller.enqueue(first ? { ...part, providerMetadata: { ...metadata, liteLLM: { generationId: first } } } : part)
          return
        }
      },
      async cancel(reason) {
        cancellation.abort(reason)
        await reader.cancel(reason)
      },
    }),
  }
}

export function liteLLMBaseUrl(url = gatewayLiteLlm()?.url): string | undefined {
  return url && (url.endsWith('/v1') ? url : url + '/v1')
}

function connection() {
  const config = gatewayLiteLlm()
  const baseURL = liteLLMBaseUrl(config?.url)
  if (!config || !baseURL) throw new Error('litellm_not_configured')
  return { baseURL, apiKey: config.masterKey }
}

export const SUBSCRIPTION_CHAT_CALL_HEADER = 'x-mikka-subscription-call-id'

/** Serialize subscription model requests through an in-process transport. */
export function createSubscriptionChatModel(modelId: string, transport: (init?: RequestInit) => Promise<Response>): Extract<LanguageModel, { specificationVersion: 'v4' }> {
  return createOpenAICompatible({ name: 'mikka-subscription', baseURL: 'http://subscription-worker.invalid/v1',
    apiKey: 'private-transport', includeUsage: true, fetch: (_input, init) => transport(init) }).chatModel(modelId)
}

/** The SDK produces and consumes the native protocol over the private CPA transport. */
export function createSubscriptionSearchModel(modelId: string, backend: NativeWebSearchBackend, transport: (init?: RequestInit) => Promise<Response>) {
  const baseURL = 'http://subscription-worker.invalid/v1'
  const fetch: typeof globalThis.fetch = (_input, init) => transport(init)
  return backend === 'anthropic'
    ? createAnthropic({ baseURL, authToken: 'private-transport', fetch }).messages(modelId)
    : createOpenAI({ baseURL, apiKey: 'private-transport', fetch }).responses(modelId)
}

export function liteLLMResponseCost(headers: HeadersInit | undefined): number | null {
  const raw = new Headers(headers).get('x-litellm-response-cost')
  if (raw === null || raw.trim() === '') return null
  return toMicros(Number(raw))
}

function toMicros(dollars: unknown): number | null {
  if (typeof dollars !== 'number' || dollars < 0) return null
  const micros = Math.ceil(dollars * 1_000_000)
  return Number.isSafeInteger(micros) ? micros : null
}

function receipt(headers: HeadersInit | undefined) {
  const generationId = new Headers(headers).get('x-litellm-call-id')
  const costMicros = liteLLMResponseCost(headers)
  return { liteLLM: { ...(generationId && { generationId }), ...(costMicros !== null && { costMicros }) } }
}

export function liteLLMCost(metadata: unknown): number | null {
  const cost = (metadata as ReturnType<typeof receipt> | undefined)?.liteLLM?.costMicros
  return cost ?? null
}

export function liteLLMGenerationId(metadata: unknown): string | undefined {
  return (metadata as ReturnType<typeof receipt> | undefined)?.liteLLM?.generationId ?? undefined
}

function providerFields(credential: Credential) {
  return {
    model: credential.provider + '/' + credential.modelId,
    custom_llm_provider: credential.provider,
    api_base: credential.baseUrl.replace(/\/+$/, ''),
    api_key: credential.apiKey,
    disable_fallbacks: true,
    num_retries: 0,
  }
}

export function createLiteLLMModel(modelId: string, options: { user?: string; credential?: Credential; callId?: string; pro?: boolean; cyberAccessProgram?: import('../model-capabilities').CyberAccessProgram } = {}) {
  if (options.callId !== undefined && !decodeHostedCallId(options.callId)) throw new Error('hosted_call_identity_invalid')
  const config = connection()
  if (options.pro && !PRO_MODELS.has(modelKeyOf(modelId, options.credential?.provider ?? 'mikka'))) throw new Error('model_pro_unavailable')
  if (options.cyberAccessProgram && options.credential?.provider !== 'openai') throw new Error('model_daybreak_unavailable')
  const transport: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    // Auth and routing come from the server, even when an SDK caller supplies headers.
    headers.set('authorization', 'Bearer ' + config.apiKey)
    headers.delete('x-litellm-api-key')
    if (options.callId) headers.set('x-litellm-call-id', options.callId)
    else headers.delete('x-litellm-call-id')
    const payload = JSON.parse(String(init?.body))
    const path = new URL(input instanceof Request ? input.url : input).pathname
    const nativeMessages = options.credential?.nativeMessages && path.endsWith('/messages')
    const fields = options.credential && providerFields(options.credential)
    if (nativeMessages && fields) {
      fields.api_base = fields.api_base.replace(/\/v1$/, '')
      headers.set('x-litellm-api-key', 'Bearer ' + config.apiKey)
    }
    if (path.endsWith('/responses') && (options.credential?.nativeResponses || (!options.credential && managedSearchRoute(modelId))) && Array.isArray(payload.tools)
      && payload.tools.some((tool: { type?: string }) => tool.type === 'web_search' || tool.type === 'web_search_preview')) {
      // Keep the serving compatibility shim from converting a native BYOK call.
      headers.set('x-litellm-api-key', 'Bearer ' + config.apiKey)
      payload.store = false
    }
    delete payload.access_programs
    if (options.pro) {
      payload.reasoning = { mode: 'pro' }
      delete payload.service_tier
    }
    if (options.cyberAccessProgram) {
      payload.access_programs = { cyber: options.cyberAccessProgram }
    }
    const body = JSON.stringify({ ...payload, ...(options.user && { user: options.user }), ...fields })
    // Add the person's key beyond the SDK's request-body recording boundary.
    return fetch(input, { ...init, headers, body, redirect: 'error' })
  }
  const target = options.credential ? modelId : managedLiteLlmModel(modelId)
  const responsesModel = (route = target) => createOpenAI({ ...config, fetch: transport }).responses(route)
  const messagesModel = (route = target) => createAnthropic({ baseURL: config.baseURL, authToken: config.apiKey, fetch: transport }).messages(route)
  const responsesByDefault = Boolean(options.pro || options.cyberAccessProgram)
  const model = responsesByDefault ? responsesModel()
    : createOpenAICompatible({ ...config, name: 'litellm', includeUsage: true, supportsStructuredOutputs: true,
        supportedUrls: () => ({ 'image/*': [/^https?:\/\//] }), fetch: transport }).chatModel(target)

  function searchModel(params: ModelCallOptions) {
    const backend = nativeWebSearchBackendForTools(params.tools)
    if (!backend) return
    const managed = options.credential ? undefined : managedSearchRoute(modelId)
    if (managed?.backend === 'openai' && backend === 'openai') return responsesModel(managed.alias)
    if (managed?.backend === 'anthropic' && backend === 'anthropic') return managedHaikuModel(config, modelId, options.callId)
    if (backend === 'openai' && options.credential?.provider === 'openai' && options.credential.nativeResponses)
      return responsesByDefault ? undefined : responsesModel()
    if (backend === 'anthropic' && options.credential?.provider === 'anthropic' && options.credential.nativeMessages)
      return messagesModel()
    throw new Error('model_native_web_search_unavailable')
  }
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      async wrapGenerate({ doGenerate, params }) {
        const selected = searchModel(params)
        const result = await (selected ? selected.doGenerate(params) : doGenerate())
        if (selected?.provider === 'gateway') {
          const generationId = gatewayGenerationId(result.providerMetadata)
          const costMicros = await gatewayGenerationCost(config, modelId, generationId, params.abortSignal)
          return { ...result, providerMetadata: { ...result.providerMetadata, liteLLM: { ...(generationId && { generationId }), costMicros } } }
        }
        return { ...result, providerMetadata: { ...result.providerMetadata, ...receipt(result.response?.headers) } }
      },
      transformParams: async ({ type, params }) => type === 'stream' ? { ...params, includeRawChunks: true } : params,
      async wrapStream({ doStream, params }) {
        const selected = searchModel(params)
        const result = await (selected ? selected.doStream(params) : doStream())
        if (selected?.provider === 'gateway') return managedHaikuStream(result, (generationId, signal) =>
          gatewayGenerationCost(config, modelId, generationId, params.abortSignal ? AbortSignal.any([signal, params.abortSignal]) : signal))
        const { liteLLM } = receipt(result.response?.headers)
        let streamCost: number | null = null
        return {
          ...result,
          stream: result.stream.pipeThrough(new TransformStream({
            transform(part, controller) {
              if (part.type === 'raw') {
                const event = part.rawValue as { usage?: { cost?: unknown }; response?: { usage?: { cost?: unknown } } } | null
                streamCost = toMicros(event?.usage?.cost ?? event?.response?.usage?.cost) ?? streamCost
                return
              }
              const costMicros = streamCost ?? (liteLLM.costMicros || undefined)
              controller.enqueue(part.type === 'finish'
                ? { ...part, providerMetadata: { ...part.providerMetadata, liteLLM: { ...liteLLM, costMicros: costMicros ?? null } } }
                : part)
            },
          })),
        }
      },
    },
  })
}

export function createLiteLLMTranscriptionModel(modelId: string, credential: Credential) {
  const config = connection()
  return createOpenAI({
    ...config,
    async fetch(input, init) {
      if (!(init?.body instanceof FormData)) throw new Error('litellm_transcription_body_invalid')
      const { model, api_key, api_base } = providerFields(credential)
      init.body.set('model', model)
      init.body.set('api_key', api_key)
      init.body.set('api_base', api_base)
      const headers = new Headers(init.headers)
      headers.set('x-litellm-num-retries', '0')
      headers.set('authorization', 'Bearer ' + config.apiKey)
      headers.delete('x-litellm-api-key')
      return fetch(input, { ...init, headers, redirect: 'error' })
    },
  }).transcription(modelId)
}
