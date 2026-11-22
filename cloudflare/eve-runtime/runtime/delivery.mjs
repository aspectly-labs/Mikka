import { singletonContainerName } from './config.mjs'

/** Durable wake delivery for a Cloudflare-hosted Eve.
 *
 * Two paths land here:
 *  - `EVE_WAKE` buffers the api->eve `POST /eve/v1/mikka/events` call whenever the
 *    container cannot answer, so a stopped or starting host never drops an event.
 *    The product outbox (coordinator_events.deliveredAt IS NULL) stays the claim
 *    authority; this queue only accelerates recovery. Redelivery is safe because
 *    Eve's session key is `mikka-event:<eventId>` and `markEventAccepted` is
 *    idempotent.
 *  - `eveWorkflowDelivery` is the `EveWorkflowDelivery` service entrypoint the
 *    Cloudflare World queue consumer (`@mikka/eve-cloudflare-world`) posts to.
 *    `containerFetch` starts a sleeping container and waits for its port, so a
 *    queued workflow step, hook wake or delayed job itself is the wake signal.
 *
 * Both paths preserve finite retries: the consumer acks only a delivered
 * response; every other outcome retries with bounded backoff until the queue's
 * configured dead-letter queue keeps the original envelope.
 */
export const EVE_WAKE_EVENT_PATH = '/eve/v1/mikka/events'
const flowPath = '/.well-known/workflow/v1/flow'
const bufferedHeaders = new Set([
  'content-type', 'x-mikka-eve-binding-scope',
  'x-mikka-eve-scope', 'x-mikka-bot-id', 'x-mikka-submission-id', 'x-mikka-evaluation-id',
  'x-mikka-workspace-id', 'x-mikka-locale',
])
const bufferedBodyLimit = 64 * 1024
const requiredDeliveryHeaders = [
  'content-type', 'x-mikka-eve-release', 'cf-queue-retry-count', 'x-mikka-queue-time', 'x-mikka-queue-signature',
]
const no = status => new Response(null, { status, headers: { 'cache-control': 'no-store' } })

export function isWakeEventRequest(method, pathname) {
  return method === 'POST' && pathname === EVE_WAKE_EVENT_PATH
}

/** Read the small event body once so it can serve both the direct forward and a
 * durable copy. The rebuilt request always carries the body again; an oversize
 * or unreadable body simply produces no envelope. */
export async function eveWakeEnvelope(url, headers, request) {
  let body
  try { body = await request.text() } catch { return { request } }
  const rebuilt = new Request(request.url, { method: request.method, headers: request.headers, body })
  if (new TextEncoder().encode(body).length > bufferedBodyLimit) return { request: rebuilt }
  const kept = {}
  for (const name of bufferedHeaders) if (headers.has(name)) kept[name] = headers.get(name)
  return {
    envelope: { v: 1, bufferedAt: Date.now(), path: url.pathname, search: url.search, headers: kept, body },
    request: rebuilt,
  }
}

/** Persist the event delivery before another attempt. Queue send failures must
 * not change the caller's contract: the product outbox still owns the claim. */
export async function bufferEveWake(env, envelope) {
  if (typeof env.EVE_WAKE?.send !== 'function') return false
  try {
    await env.EVE_WAKE.send(envelope, { contentType: 'json' })
    return true
  } catch {
    console.error('CF_EVE_WAKE_BUFFER_UNAVAILABLE')
    return false
  }
}

/** EveService entrypoint path: try the live host first, buffer a durable copy
 * only when it reports itself unavailable. The caller always receives the real
 * upstream response; delivery completion stays idempotent end to end. */
export async function eveServiceDelivery(request, env, headers, forward) {
  const buffered = env.EVE_WAKE && isWakeEventRequest(request.method, new URL(request.url).pathname)
    ? await eveWakeEnvelope(new URL(request.url), headers, request)
    : null
  let response
  try {
    response = await forward(buffered?.request ?? request)
  } catch (error) {
    if (buffered?.envelope) await bufferEveWake(env, buffered.envelope)
    throw error
  }
  if (buffered?.envelope && response.status === 503) await bufferEveWake(env, buffered.envelope)
  return response
}

function wakeTarget(env) {
  const { EVE_RELEASE_ID: name = singletonContainerName } = env
  return env.EVE_RUNTIME.getByName(name)
}

function validWakeEntry(entry) {
  return entry && entry.v === 1 && typeof entry.path === 'string' && entry.path.startsWith('/eve/v1/')
    && typeof entry.search === 'string' && typeof entry.body === 'string'
    && entry.headers && typeof entry.headers === 'object'
    && new TextEncoder().encode(entry.body).length <= bufferedBodyLimit
}

/** Rebuild the buffered call against this deployment's public origin. The
 * binding-scope header was already stamped by the EveService entrypoint; the
 * queue is a private service path and re-delivers it unchanged. */
function wakeRequest(entry, env) {
  const origin = env.EVE_PUBLIC_ORIGIN ?? 'https://eve.internal'
  const target = new URL(entry.path + entry.search, origin)
  const headers = new Headers()
  for (const name of bufferedHeaders) if (typeof entry.headers[name] === 'string') headers.set(name, entry.headers[name])
  headers.set('x-forwarded-host', target.host)
  headers.set('x-forwarded-proto', target.protocol.slice(0, -1))
  headers.set('x-mikka-wake-delivery', 'queued')
  return new Request(target, { method: 'POST', headers, body: entry.body, duplex: 'half' })
}

function wakeEventKey(entry, message) {
  try {
    const eventId = JSON.parse(entry.body)?.eventId
    if (typeof eventId === 'string' && eventId) return entry.path + ':' + eventId
  } catch { /* fall back to the queue identity */ }
  return message.id
}

export async function consumeEveWake(batch, env, ctx) {
  const seen = new Set()
  await Promise.all(batch.messages.map(async message => {
    try {
      const entry = message.body
      if (!validWakeEntry(entry)) throw new Error('Invalid Eve wake entry')
      // One logical event is delivered once per batch; wider duplicates land
      // on Eve's `mikka-event:<id>` idempotency key and the product claim.
      const key = wakeEventKey(entry, message)
      if (seen.has(key)) { message.ack(); return }
      seen.add(key)
      const response = await wakeTarget(env).fetch(wakeRequest(entry, env))
      if (response.body) ctx?.waitUntil(response.body.cancel().catch(() => {}))
      if (!response.ok) throw new Error('Eve wake delivery not accepted')
      message.ack()
    } catch {
      message.retry({ delaySeconds: Math.min(60, 2 ** Math.min(6, message.attempts - 1)) })
    }
  }))
}

/** Service entrypoint the World queue consumer posts to. The pinned release,
 * retry count, queue time and signature headers are required exactly as the
 * `businessWorkflowDelivery` worker requires them; the Node executor inside the
 * container verifies the signature over the original bytes and echoes the
 * release on the response. */
export function eveWorkflowDelivery(request, env) {
  const url = new URL(request.url)
  if (url.href !== 'https://eve.internal' + flowPath || request.method !== 'POST') return no(404)
  const revision = env.EVE_RELEASE_ID
  if (!revision || request.headers.get('x-mikka-eve-release') !== revision) return no(409)
  for (const name of requiredDeliveryHeaders) if (!request.headers.get(name)) return no(403)
  return wakeTarget(env).fetch(request)
}
