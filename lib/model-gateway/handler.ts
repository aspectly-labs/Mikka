import 'server-only'
import { randomUUID } from 'node:crypto'
import { trace } from '@opentelemetry/api'
import { db, pool } from '@/lib/db'
import { catalogModel } from '@/lib/model-catalog'
import { PaidResourceError } from '@/lib/abuse/policy'
import { requestGatewayToken, verifyGatewayToken, type GatewayGrant } from './token'
import { upstreamRequest, type GatewayOperation, type GatewayUpstream } from './upstream'
import { gatewayCostMicroUsd, readGatewayReceipt, type GatewayProtocol, type GatewayUsage } from './usage'
import { withoutDisabledFeatures } from './features'
import { isCloudEdition } from '@/lib/edition'
import { runtimeEnv } from '@/lib/env/server'
import { gatewayLiteLlm, SELF_HOSTED_DEFAULT_CATALOG_ID } from './config'
import { readRunChain } from '@/lib/run-chain'
import { claimSubscriptionUsage, finishSubscriptionUsage, recordExternalModelUsage, type ModelReceipt } from './ledger'
import { modelGatewayProtocolBody } from './protocol-fields.mjs'
import { liteLLMResponseCost } from './litellm-client'
import { observeUsageStream, usageTap } from './usage-tap'
import { WorkerRefusal } from '../../packages/daemon/src/subscription-worker-client'

/** The same input-size boundary the hosted model applies to one call. */
const MAX_BODY_BYTES = 16 * 1024 * 1024

type Fetch = typeof fetch
export interface GatewayDependencies {
  fetch: Fetch
  verify(token: string): Promise<GatewayGrant | null>
  /** The upstream for a grant; throws a `GatewayRefusal` when nothing may serve it. */
  subscription?(grant: GatewayGrant, protocol: GatewayProtocol, operation: GatewayOperation, body: Record<string, unknown>, request: Request): Promise<Response>
  upstream(grant: GatewayGrant, protocol: GatewayProtocol): Promise<{ upstream: GatewayUpstream; features?: import('./features').GatewayFeatures; daybreakAllowed?: boolean }>
  /** Mikka 额度 only: holds a call's worth of credit; resolves to the hold's id. Throws `PaidResourceError` when nothing can pay. */
  reserve(grant: GatewayGrant, id: string): Promise<void>
  settle(id: string, cost: number | null, usage: GatewayUsage | null, generationId?: string, messageId?: string | null): Promise<void>
  recordExternal?(grant: GatewayGrant, id: string, receipt: ModelReceipt): Promise<void>
  beginSubscriptionReceipt?(grant: GatewayGrant, id: string): Promise<(receipt: ModelReceipt, complete: boolean) => Promise<void>>
  /** The catalogue the cost is priced from. */
  catalogue(): Promise<readonly import('@/lib/model-catalog').CatalogModel[]>
  /** Nothing can pay: the run stops with the refusal as its reason, so the thread shows 「Mikka 额度已用完」. */
  refused?(grant: GatewayGrant, code: string): Promise<void>
}

/** A refusal the CLI reads as its provider's own error. */
export class GatewayRefusal extends Error {
  constructor(readonly status: number, readonly code: string, options?: ErrorOptions) { super(code, options); this.name = 'GatewayRefusal' }
}

function errorResponse(protocol: GatewayProtocol, status: number, code: string): Response {
  const body = protocol === 'anthropic'
    ? { type: 'error', error: { type: status === 401 ? 'authentication_error' : status === 402 ? 'billing_error' : status === 403 ? 'permission_error' : status === 413 ? 'request_too_large' : status === 429 ? 'rate_limit_error' : status === 400 ? 'invalid_request_error' : 'api_error', message: code } }
    : { error: { message: code, type: status === 402 ? 'insufficient_quota' : status === 401 ? 'invalid_api_key' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'server_error' : 'invalid_request_error', code } }
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * One request from a run's CLI (decision 2026-11-15-2000): authenticate the
 * run's token, pin the run's frozen model, hold credit when Mikka pays, forward
 * as a stream, then settle at the list price of what the provider reported.
 */
export async function handleModelGateway(request: Request, protocol: GatewayProtocol, operation: GatewayOperation, dependencies: GatewayDependencies = modelGatewayDependencies()): Promise<Response> {
  const token = requestGatewayToken(request.headers)
  const grant = token ? await dependencies.verify(token) : null
  if (!grant) return errorResponse(protocol, 401, 'model_gateway_token_invalid')
  if ((grant.harness === 'claude_code') !== (protocol === 'anthropic')) return errorResponse(protocol, 403, 'model_gateway_protocol_mismatch')
  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > MAX_BODY_BYTES) return errorResponse(protocol, 413, 'model_gateway_body_too_large')
  let body: Record<string, unknown>
  try {
    const text = await request.text()
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) return errorResponse(protocol, 413, 'model_gateway_body_too_large')
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return errorResponse(protocol, 400, 'model_gateway_body_invalid')
    body = parsed as Record<string, unknown>
  } catch { return errorResponse(protocol, 400, 'model_gateway_body_invalid') }

  let resolved: Awaited<ReturnType<GatewayDependencies['upstream']>> | undefined
  if (grant.source.kind !== 'subscription') {
    try { resolved = await dependencies.upstream(grant, protocol) }
    catch (error) {
      if (error instanceof GatewayRefusal) return errorResponse(protocol, error.status, error.code)
      throw new Error('model_gateway_upstream_unavailable', { cause: error })
    }
  }
  const metered = grant.source.kind === 'credits' && operation !== 'count_tokens'
  const holdId = randomUUID()
  if (metered) {
    try { await dependencies.reserve(grant, holdId) }
    catch (error) {
      if (error instanceof PaidResourceError) {
        await dependencies.refused?.(grant, error.code).catch((cause: unknown) =>
          console.warn(JSON.stringify({ msg: 'model_gateway_refusal_unrecorded', runId: grant.runId, error: cause instanceof Error ? cause.name : 'unknown' })))
        return errorResponse(protocol, 402, error.code)
      }
      throw new Error('model_gateway_reserve_failed', { cause: error })
    }
  }
  let response: Response
  try {
    if (resolved) {
      const outgoing = upstreamRequest({
        protocol, operation, model: grant.model,
        body: withoutDisabledFeatures(body, resolved.features ?? {}),
        clientHeaders: request.headers, upstream: resolved.upstream,
        ...(grant.pro ? { pro: true } : grant.serviceTier ? { serviceTier: grant.serviceTier } : {}),
        ...(grant.cyberAccessProgram && resolved.daybreakAllowed !== false ? { cyberAccessProgram: grant.cyberAccessProgram } : {}),
      })
      response = await dependencies.fetch(outgoing.url, { method: 'POST', headers: outgoing.headers, body: JSON.stringify(outgoing.body), redirect: 'error', signal: request.signal })
    } else if (dependencies.subscription) {
      response = await dependencies.subscription(grant, protocol, operation, body, request)
    } else {
      return errorResponse(protocol, 503, 'model_gateway_unconfigured')
    }
  } catch (error) {
    if (metered) await dependencies.settle(holdId, 0, null)
    if (error instanceof GatewayRefusal) return errorResponse(protocol, error.status, error.code)
    if (request.signal.aborted) return errorResponse(protocol, 499, 'model_gateway_client_closed')
    console.warn(JSON.stringify({ msg: 'model_gateway_upstream_failed', runId: grant.runId, source: grant.source.kind, error: error instanceof Error ? error.name : 'unknown' }))
    return errorResponse(protocol, 502, 'model_gateway_upstream_failed')
  }
  const generationId = response.headers.get('x-litellm-call-id') ?? undefined
  const headers = new Headers({ 'cache-control': 'no-store' })
  const type = response.headers.get('content-type')
  if (type) headers.set('content-type', type)
  let nativeReceipt: Awaited<ReturnType<NonNullable<GatewayDependencies['beginSubscriptionReceipt']>>> | undefined
  if (response.ok && grant.source.kind === 'subscription' && operation !== 'count_tokens') {
    if (!dependencies.beginSubscriptionReceipt || !grant.workspaceId) {
      await response.body?.cancel().catch(() => undefined)
      return errorResponse(protocol, 502, 'model_gateway_subscription_receipt_unavailable')
    }
    trace.getActiveSpan()?.setAttribute('mikka.model.call_id', holdId)
    try { nativeReceipt = await dependencies.beginSubscriptionReceipt(grant, holdId) }
    catch (error) { await response.body?.cancel().catch(() => undefined); throw error }
  }
  const observable = Boolean(nativeReceipt) || (operation !== 'count_tokens' && !!dependencies.recordExternal && !!grant.workspaceId)
  if ((!metered && !observable) || !response.body) {
    if (metered) await dependencies.settle(holdId, response.ok ? null : 0, null, generationId)
    return new Response(response.body, { status: response.status, headers })
  }
  if (!response.ok) {
    // A refused request (bad parameters, provider limits) cost nothing.
    if (metered) await dependencies.settle(holdId, 0, null, generationId)
    return new Response(response.body, { status: response.status, headers })
  }
  const tap = usageTap(type?.includes('text/event-stream') ?? false, async (text, complete) => {
    const receipt = readGatewayReceipt(protocol, text)
    const cost = receipt.cost ?? liteLLMResponseCost(response.headers)
    if (metered) {
      const settledCost = receipt.usage
        ? gatewayCostMicroUsd(catalogModel(grant.model, await dependencies.catalogue()), receipt.usage) : null
      await dependencies.settle(holdId, settledCost, receipt.usage, generationId, receipt.messageId)
    } else if (nativeReceipt) {
      await nativeReceipt(receipt, complete && receipt.usage !== null)
    } else if (receipt.messageId || receipt.usage || cost !== null) {
      await dependencies.recordExternal?.(grant, holdId, { ...receipt, cost, generationId })
    }
  }, nativeReceipt ? protocol : undefined)
  if (nativeReceipt) return new Response(observeUsageStream(response.body, tap, request.signal), { status: response.status, headers })
  // A client that stops reading still owes what the provider already produced.
  request.signal.addEventListener('abort', () => { void tap.finish() }, { once: true })
  return new Response(response.body.pipeThrough(tap.stream), { status: response.status, headers })
}

export function modelGatewayDependencies(): GatewayDependencies {
  return {
    fetch,
    verify: token => verifyGatewayToken(pool, token),
    upstream: (grant, protocol) => resolveGatewayUpstream(grant, protocol),
    subscription: forwardNativeSubscription,
    async reserve(grant, id) {
      if (!grant.workspaceId) throw new PaidResourceError('free_allowance_used')
      const [{ hostedUsage }, { withSharedCredits }, { hostedBillingScope }] = await Promise.all([
        import('@/lib/abuse/runtime'), import('@/lib/credit-shares'), import('@/lib/abuse/context')])
      const workspaceId = grant.workspaceId
      const threadId = (await readRunChain(pool, grant.ownerId, grant.runId))?.rootRunId
      await hostedBillingScope.run({ workspaceId, ownerId: grant.ownerId, runId: grant.runId, actorId: grant.ownerId, threadId, billingSource: 'credits' },
        () => withSharedCredits(workspaceId, payer => hostedUsage.reserve(payer, grant.model, id, runtimeEnv())))
    },
    async settle(id, cost, usage, generationId, messageId) {
      const { hostedUsage } = await import('@/lib/abuse/runtime')
      await hostedUsage.settle(id, cost, usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, generationId,
        usage ? { read: usage.cacheReadTokens, write: usage.cacheWriteTokens } : null, messageId)
    },
    async recordExternal(grant, id, receipt) {
      if (!grant.workspaceId || grant.source.kind !== 'api_key') return
      const threadId = (await readRunChain(pool, grant.ownerId, grant.runId))?.rootRunId ?? null
      await recordExternalModelUsage(db, { ...receipt, id, threadId, workspaceId: grant.workspaceId, ownerId: grant.ownerId,
        runId: grant.runId, model: grant.model, source: 'api_key' })
    },
    async beginSubscriptionReceipt(grant, callId) {
      if (!grant.workspaceId) throw new Error('model_gateway_billing_scope_missing')
      const threadId = (await readRunChain(pool, grant.ownerId, grant.runId))?.rootRunId ?? null
      const id = `subscription-native:${callId}`
      const claimed = await claimSubscriptionUsage(db, { id, workspaceId: grant.workspaceId, ownerId: grant.ownerId,
        runId: grant.runId, model: grant.model, threadId })
      return async (receipt, complete) => { if (claimed) await finishSubscriptionUsage(db, id, receipt, complete) }
    },
    catalogue: async () => (await import('@/lib/model-catalog-server')).modelCatalog(),
    async refused(grant, code) {
      const stopped = await pool.query(`UPDATE agent_runs SET "stopRequestedAt"=COALESCE("stopRequestedAt",now()),"stopReason"=COALESCE("stopReason",$2),
          error=COALESCE(error,$2),"updatedAt"=now() WHERE id=$1 AND status NOT IN ('succeeded','failed','stopped','cancelled') RETURNING id`, [grant.runId, code])
      if (stopped.rowCount) await (await import('@/lib/live/panels')).runChanged(pool, grant.runId)
    },
  }
}

const nativeSubscriptionRefusalStatus = new Map<string, number>([
  ['reconnect_required', 401],
  ['provider_access_denied', 403],
  ['provider_request_rejected', 400],
  ['subscription_payload_too_large', 413],
  ['subscription_rate_limited', 429],
  ['provider_temporarily_unavailable', 503],
])

export async function forwardNativeSubscription(grant: GatewayGrant, protocol: GatewayProtocol, operation: GatewayOperation,
  body: Record<string, unknown>, request: Request, supplied?: Pick<import('@/lib/subscription-service').SubscriptionService, 'nativeRun' | 'nativeRequest'>) {
  if (grant.source.kind !== 'subscription') throw new GatewayRefusal(403, 'model_gateway_protocol_mismatch')
  const service = supplied ?? (await import('@/lib/subscription-runtime')).subscriptionRuntime(true)
  const use = await service.nativeRun(grant.ownerId, grant.source.deviceId, grant.runId)
  const path = operation === 'responses' ? '/responses'
    : operation === 'count_tokens' ? '/v1/messages/count_tokens' : '/v1/messages'
  const headers: Record<string, string> = Object.fromEntries(
    ['accept', 'anthropic-version', 'anthropic-beta', 'openai-beta'].flatMap(name => {
      const value = request.headers.get(name)
      return value ? [[name, value]] : []
    }))
  const payload: Record<string, unknown> = {
    ...modelGatewayProtocolBody(protocol, body),
    model: grant.model,
    ...(protocol === 'openai' && operation === 'responses' && grant.cyberAccessProgram
      ? { access_programs: { cyber: grant.cyberAccessProgram } }
      : {}),
  }
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_BODY_BYTES) {
    throw new GatewayRefusal(413, 'model_gateway_body_too_large')
  }
  const upstream = await service.nativeRequest(use, { path, headers, body: payload }, request.signal).catch(error => {
    if (!(error instanceof WorkerRefusal)) throw error
    const status = nativeSubscriptionRefusalStatus.get(error.code)
    if (!status) throw error
    throw new GatewayRefusal(status, error.code, { cause: error })
  })
  return new Response(upstream.body, { headers: { 'content-type': upstream.contentType, ...(upstream.generationId ? { 'x-litellm-call-id': upstream.generationId } : {}) } })
}

/** The run's frozen source, opened for this one request. */
export async function resolveGatewayUpstream(grant: GatewayGrant, protocol: GatewayProtocol, env: Readonly<Record<string, string | undefined>> = runtimeEnv()): Promise<{ upstream: GatewayUpstream; features?: import('./features').GatewayFeatures; daybreakAllowed?: boolean }> {
  const litellm = gatewayLiteLlm(env)
  if (!litellm) throw new GatewayRefusal(503, 'model_gateway_unconfigured')
  if (grant.source.kind === 'credits') {
    if (!isCloudEdition(env) && grant.model === SELF_HOSTED_DEFAULT_CATALOG_ID) return { upstream: litellm, daybreakAllowed: false }
    const models = await (await import('@/lib/model-catalog-server')).modelCatalog()
    if (!catalogModel(grant.model, models)?.pricing) throw new GatewayRefusal(400, 'model_gateway_model_unpriced')
    return { upstream: litellm, daybreakAllowed: false }
  }
  if (grant.source.kind !== 'api_key') throw new GatewayRefusal(403, 'model_gateway_protocol_mismatch')
  const { openGatewayApiKey } = await import('@/lib/model-api-keys')
  const opened = await openGatewayApiKey(pool, grant.source.keyId, env).catch((error: unknown) => {
    throw new GatewayRefusal(401, 'model_gateway_key_unavailable', { cause: error })
  })
  const { liteLlmByokRoute } = await import('@/lib/model-api-key-providers')
  const route = liteLlmByokRoute(opened.key, grant.harness)
  if (!route) throw new GatewayRefusal(400, 'model_gateway_protocol_unsupported')
  let daybreakAllowed = false
  if (grant.cyberAccessProgram && opened.key.provider === 'openai') {
    const { cyberAccessProgram, daybreakTierFor } = await import('@/lib/model-capabilities')
    const tier = daybreakTierFor(opened.key.daybreak, grant.model)
    daybreakAllowed = tier !== undefined && cyberAccessProgram(tier) === grant.cyberAccessProgram
  }
  return { upstream: { ...litellm, credential: { key: opened.apiKey, ...route } }, features: opened.features, daybreakAllowed }
}
