import 'server-only'
import { SubscriptionRefusal } from '@mikka/protocol/subscription'
import { WorkerRefusal } from '../packages/daemon/src/subscription-worker-client'
import { db, pool } from './db'
import { claimSubscriptionUsage, finishSubscriptionUsage, type ModelReceipt } from './model-gateway/ledger'
import { SUBSCRIPTION_CHAT_CALL_HEADER } from './model-gateway/litellm-client'
import { readRunChain } from './run-chain'
import { BACKEND_FAILURES, GENERATION_FAILURES, PRIVATE_FAILURES } from './subscription-generation-diagnostics'
import { chatEnvelopeSchema, SUBSCRIPTION_CHAT_MAX_BYTES, verifySubscriptionChat } from './subscription-chat-ticket'
import { subscriptionRuntime } from './subscription-runtime'
import { withRunSpan } from './tracing/context'

// A JSON string can take up to six encoded bytes per original byte.
const ENVELOPE_MAX_BYTES = 6 * SUBSCRIPTION_CHAT_MAX_BYTES + 8192
const deny = (status: number) => new Response(null, { status, headers: { 'cache-control': 'no-store' } })
const reported = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null

async function readBoundedBody(request: Request) {
  if (!request.body || Number(request.headers.get('content-length')) > ENVELOPE_MAX_BYTES) return null
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > ENVELOPE_MAX_BYTES) { await reader.cancel(); return null }
      parts.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(parts).toString('utf8')
}

function observeChatReceipt() {
  const decoder = new TextDecoder()
  const receipt: ModelReceipt = { messageId: null, cost: null, usage: null }
  let line = ''
  let complete = false
  return {
    receipt,
    get complete() { return complete },
    push(chunk: Uint8Array) {
      const lines = (line + decoder.decode(chunk, { stream: true })).split('\n')
      line = lines.pop() ?? ''
      if (line.length > SUBSCRIPTION_CHAT_MAX_BYTES) line = ''
      for (const part of lines) {
        if (!part.startsWith('data:')) continue
        const value = part.slice(5).trim()
        if (value === '[DONE]') { complete = true; continue }
        try {
          const data = JSON.parse(value)
          if (!receipt.messageId && typeof data?.id === 'string' && /^[\w.-]{1,200}$/.test(data.id)) receipt.messageId = data.id
          const usage = data?.usage
          if (!usage || typeof usage !== 'object') continue
          const inputTokens = reported(usage.prompt_tokens), outputTokens = reported(usage.completion_tokens)
          if (inputTokens === null || outputTokens === null) continue
          receipt.usage = {
            inputTokens, outputTokens,
            cacheReadTokens: reported(usage.prompt_tokens_details?.cached_tokens),
            cacheWriteTokens: reported(usage.prompt_tokens_details?.cache_write_tokens),
          }
        } catch { /* Provider output still passes through unchanged. */ }
      }
    },
  }
}

const errorCode = (error: unknown) => {
  const code = error instanceof WorkerRefusal || error instanceof SubscriptionRefusal ? error.code : ''
  return GENERATION_FAILURES.has(code) || BACKEND_FAILURES.has(code) || PRIVATE_FAILURES.has(code) ? code : 'subscription_worker_unavailable'
}
const errorFrame = (error: unknown) => new TextEncoder().encode(`data: ${JSON.stringify({ error: { type: 'mikka_subscription_failure', code: errorCode(error), message: 'Subscription model failed' } })}\n\n`)

export async function handleSubscriptionChat(request: Request, service = subscriptionRuntime) {
  let intent: ReturnType<typeof verifySubscriptionChat>
  let payload: unknown
  try {
    const body = await readBoundedBody(request)
    const envelope = body && chatEnvelopeSchema.safeParse(JSON.parse(body))
    if (!envelope || !envelope.success || Buffer.byteLength(envelope.data.payload, 'utf8') > SUBSCRIPTION_CHAT_MAX_BYTES) return deny(400)
    intent = verifySubscriptionChat(envelope.data)
    if (!intent) return deny(401)
    payload = JSON.parse(envelope.data.payload)
    if (!payload || typeof payload !== 'object' || !('model' in payload) || payload.model !== intent.model
      || !('stream' in payload) || payload.stream !== true) return deny(400)
  } catch { return deny(400) }
  const { use, model, callId, traceparent } = intent
  const headers = { 'content-type': 'text/event-stream', 'cache-control': 'no-store', [SUBSCRIPTION_CHAT_CALL_HEADER]: callId }
  return withRunSpan('model.subscription.cpa', { 'mikka.model.call_id': callId }, async () => {
    let admitted: Awaited<ReturnType<ReturnType<typeof service>['openLiteLLMChat']>>
    try { admitted = await service().openLiteLLMChat(use, model, payload, request.signal) }
    catch (error) {
      return new Response(errorFrame(error), { headers })
    }
    const threadId = use.runId ? (await readRunChain(pool, use.ownerId, use.runId))?.rootRunId : null
    if (use.runId && !threadId) return deny(403)
    if (!await claimSubscriptionUsage(db, { ...use, id: callId, model, threadId: threadId ?? null })) return deny(409)
    const reader = admitted.start().getReader()
    const observed = observeChatReceipt()
    let finished = false
    const finish = async () => {
      if (finished) return
      finished = true
      await finishSubscriptionUsage(db, callId, observed.receipt, observed.complete && observed.receipt.usage !== null)
    }
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await reader.read()
          if (done) {
            await finish()
            reader.releaseLock()
            if (!observed.complete) controller.enqueue(errorFrame(new WorkerRefusal()))
            controller.close()
            return
          }
          observed.push(value)
          // Commit token counts before the client can accept a completed result.
          if (observed.complete) await finish()
          controller.enqueue(value)
        } catch (error) {
          await finish()
          reader.releaseLock()
          if (request.signal.aborted) controller.error(request.signal.reason)
          else { controller.enqueue(errorFrame(error)); controller.close() }
        }
      },
      async cancel(reason) { try { await reader.cancel(reason) } finally { reader.releaseLock(); await finish() } },
    })
    return new Response(stream, { headers })
  }, traceparent ? { traceparent } : undefined)
}
