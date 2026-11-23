import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import {
  bufferEveWake, consumeEveWake, eveServiceDelivery, eveWakeEnvelope, eveWorkflowDelivery,
  isWakeEventRequest, EVE_WAKE_EVENT_PATH,
} from '../runtime/delivery.mjs'

const flowPath = '/.well-known/workflow/v1/flow'
const deliveryHeaders = () => new Headers({
  'content-type': 'application/json', 'x-mikka-eve-release': 'fixture-1',
  'cf-queue-retry-count': '0', 'x-mikka-queue-time': String(Date.now()),
  'x-mikka-queue-signature': 'a'.repeat(64),
})

function runtimeEnv(overrides = {}) {
  const calls = []
  return {
    calls,
    env: {
      EVE_RELEASE_ID: 'fixture-1',
      EVE_PUBLIC_ORIGIN: 'https://eve.example.test',
      EVE_RUNTIME: { getByName(name) { calls.push(name); return { fetch: overrides.fetch ?? (() => new Response('{"ok":true}')) } } },
      ...overrides.env,
    },
  }
}

test('the durable wake buffer only accepts the internal event route', () => {
  assert.equal(EVE_WAKE_EVENT_PATH, '/eve/v1/mikka/events')
  assert.equal(isWakeEventRequest('POST', '/eve/v1/mikka/events'), true)
  assert.equal(isWakeEventRequest('GET', '/eve/v1/mikka/events'), false)
  assert.equal(isWakeEventRequest('POST', '/eve/v1/session'), false)
  assert.equal(isWakeEventRequest('POST', '/eve/v1/mikka/events/extra'), false)
})

test('the wake envelope carries the event body and only trusted headers', async () => {
  const url = new URL('https://eve.internal/eve/v1/mikka/events?botId=bot-1')
  const headers = new Headers({
    'content-type': 'application/json', 'x-mikka-eve-binding-scope': '{"ownerId":"u1"}',
    'x-mikka-bot-id': 'bot-1', authorization: 'Bearer must-not-buffer', cookie: 'session=must-not-buffer',
  })
  const request = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"eventId":"e-1"}' })
  const result = await eveWakeEnvelope(url, headers, request)
  assert.deepEqual(result.envelope.headers, {
    'content-type': 'application/json', 'x-mikka-eve-binding-scope': '{"ownerId":"u1"}', 'x-mikka-bot-id': 'bot-1',
  })
  assert.equal(result.envelope.body, '{"eventId":"e-1"}')
  assert.equal(result.envelope.path, '/eve/v1/mikka/events')
  assert.equal(result.envelope.search, '?botId=bot-1')
  // The rebuilt request still carries a readable body for the direct forward.
  assert.equal(await result.request.text(), '{"eventId":"e-1"}')
  const oversized = new Request(url, { method: 'POST', body: 'x'.repeat(64 * 1024 + 1) })
  const skipped = await eveWakeEnvelope(url, headers, oversized)
  assert.equal(skipped.envelope, undefined)
  assert.equal((await skipped.request.text()).length, 64 * 1024 + 1)
})

test('the live answer wins and only an unavailable host falls back to the queue', async () => {
  const sent = []
  const env = { EVE_WAKE: { async send(envelope) { sent.push(envelope) } } }
  const request = () => new Request('https://eve.internal/eve/v1/mikka/events', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"eventId":"e-9"}',
  })
  const headers = new Headers({ 'content-type': 'application/json' })
  const delivered = await eveServiceDelivery(request(), env, headers, async req => {
    assert.equal(await req.text(), '{"eventId":"e-9"}')
    return new Response('{"sessionId":"s1","deliveryId":"d1"}')
  })
  assert.equal(delivered.status, 200)
  assert.equal(sent.length, 0)
  const unavailable = await eveServiceDelivery(request(), env, headers, async () =>
    Response.json({ ok: false, error: 'coordinatorUnavailable' }, { status: 503 }))
  assert.equal(unavailable.status, 503)
  assert.equal(sent.length, 1)
  assert.equal(JSON.parse(sent[0].body).eventId, 'e-9')
  // Non-event routes never buffer, and neither does a missing queue binding.
  for (const path of ['/eve/v1/session', '/eve/v1/mikka/health']) {
    await eveServiceDelivery(new Request('https://eve.internal' + path, { method: 'POST', body: '{}' }), env, headers,
      async () => new Response(null, { status: 503 }))
  }
  await eveServiceDelivery(request(), {}, headers, async () => new Response(null, { status: 503 }))
  assert.equal(sent.length, 1)
})

test('a queue send failure never changes the caller contract', async () => {
  const env = { EVE_WAKE: { async send() { throw new Error('queue down') } } }
  const response = await eveServiceDelivery(
    new Request('https://eve.internal/eve/v1/mikka/events', { method: 'POST', body: '{"eventId":"e-1"}' }),
    env, new Headers(), async () => new Response(null, { status: 503 }))
  assert.equal(response.status, 503)
  assert.equal(await bufferEveWake({}, { v: 1 }), false)
})

test('the queue consumer delivers each buffered call and acks only acceptance', async () => {
  const seen = []
  const { env, calls } = runtimeEnv({ fetch: async request => { seen.push(request); return new Response('{"sessionId":"s"}') } })
  const messages = [
    { id: 'm1', attempts: 1, body: { v: 1, path: '/eve/v1/mikka/events', search: '', headers: { 'content-type': 'application/json', 'x-mikka-eve-binding-scope': '{"ownerId":"u"}' }, body: '{"eventId":"e-1"}' }, acked: 0, retried: 0, ack() { this.acked++ }, retry(o) { this.retried++; this.delay = o?.delaySeconds } },
    { id: 'm1', attempts: 1, body: { v: 1, path: '/eve/v1/mikka/events', search: '', headers: {}, body: '{"eventId":"e-1"}' }, acked: 0, retried: 0, ack() { this.acked++ }, retry() { this.retried++ } },
    { id: 'm2', attempts: 3, body: { v: 1, path: '/eve/v1/mikka/events', search: '?botId=b', headers: {}, body: '{"eventId":"e-2"}' }, acked: 0, retried: 0, ack() { this.acked++ }, retry(o) { this.retried++; this.delay = o?.delaySeconds } },
  ]
  const waits = []
  await consumeEveWake({ messages }, env, { waitUntil(p) { waits.push(p) } })
  assert.deepEqual(messages.map(m => [m.acked, m.retried]), [[1, 0], [1, 0], [1, 0]])
  // The in-batch duplicate of m1 did not reach the container.
  assert.equal(seen.length, 2)
  assert.deepEqual(calls, ['fixture-1', 'fixture-1'])
  assert.equal(seen[0].url, 'https://eve.example.test/eve/v1/mikka/events')
  assert.equal(seen[0].headers.get('x-mikka-eve-binding-scope'), '{"ownerId":"u"}')
  assert.equal(seen[0].headers.get('x-forwarded-host'), 'eve.example.test')
  assert.equal(seen[1].url, 'https://eve.example.test/eve/v1/mikka/events?botId=b')
  assert.equal(await seen[0].text(), '{"eventId":"e-1"}')
  await Promise.all(waits)
})

test('a refused delivery retries with bounded backoff; malformed entries cannot loop forever', async () => {
  const { env } = runtimeEnv({ fetch: () => new Response(null, { status: 503 }) })
  const message = { id: 'm1', attempts: 4, body: { v: 1, path: '/eve/v1/mikka/events', search: '', headers: {}, body: '{}' }, retries: [], ack() { this.acked = true }, retry(o) { this.retries.push(o?.delaySeconds) } }
  await consumeEveWake({ messages: [message] }, env, undefined)
  assert.deepEqual(message.retries, [8])
  const invalid = { id: 'm2', attempts: 1, body: { nope: true }, retries: [], ack() { this.acked = true }, retry(o) { this.retries.push(o?.delaySeconds) } }
  await consumeEveWake({ messages: [invalid] }, env, undefined)
  assert.equal(invalid.acked, undefined)
  assert.equal(invalid.retries.length, 1)
})

test('World queue delivery is release-pinned and reaches the container by name', async () => {
  const { env, calls } = runtimeEnv({ fetch: _request => new Response('ok', { headers: { 'x-mikka-eve-release': 'fixture-1' } }) })
  const delivered = await eveWorkflowDelivery(new Request('https://eve.internal' + flowPath, {
    method: 'POST', headers: deliveryHeaders(), body: '{"queueName":"__wkf","x":1}',
  }), env)
  assert.equal(delivered.status, 200)
  assert.deepEqual(calls, ['fixture-1'])
  for (const bad of [
    new Request('https://eve.internal/eve/v1/other', { method: 'POST', headers: deliveryHeaders() }),
    new Request('https://eve.internal' + flowPath, { method: 'GET', headers: deliveryHeaders() }),
  ]) assert.equal((await eveWorkflowDelivery(bad, env)).status, 404)
  const wrongRelease = new Request('https://eve.internal' + flowPath, {
    method: 'POST', headers: { ...Object.fromEntries(deliveryHeaders()), 'x-mikka-eve-release': 'other' },
  })
  assert.equal((await eveWorkflowDelivery(wrongRelease, env)).status, 409)
  const unsigned = new Request('https://eve.internal' + flowPath, { method: 'POST', headers: { 'x-mikka-eve-release': 'fixture-1' } })
  assert.equal((await eveWorkflowDelivery(unsigned, env)).status, 403)
  assert.equal((await eveWorkflowDelivery(new Request('https://eve.internal' + flowPath, { method: 'POST', headers: deliveryHeaders() }), { EVE_RELEASE_ID: undefined })).status, 409)
})

test('the worker declares the durable wake queue with bounded retries and a DLQ', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))
  const producer = config.queues.producers.find(row => row.binding === 'EVE_WAKE')
  const consumer = config.queues.consumers.find(row => row.queue === producer.queue)
  assert.ok(producer && consumer)
  assert.ok(consumer.max_retries >= 3)
  assert.equal(typeof consumer.dead_letter_queue, 'string')
})
