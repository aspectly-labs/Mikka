import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { CompositePropagator, suppressTracing, W3CTraceContextPropagator } from '@opentelemetry/core'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { RunContextPropagator, withTraceMetadata } from './context'
import { createTracerProvider, SafeExporter } from './node'
import { httpTracePeer } from '@/lib/env/hosts'

const memory = new InMemorySpanExporter()
const provider = createTracerProvider({ exporter: new SafeExporter(memory), sampleRate: 1, environment: 'dev', httpClientTracing: true })
const requests: { url: string; headers: string[]; body: string }[] = []
let handler: (request: IncomingMessage, response: ServerResponse) => void
const server = createServer((request, response) => handler(request, response))
let origin: string

before(async () => {
  provider.register({ propagator: new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new RunContextPropagator()] }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await provider.shutdown()
  trace.disable(); context.disable(); propagation.disable()
})

async function parent<T>(name: string, work: () => Promise<T>): Promise<T> {
  return context.with(ROOT_CONTEXT, () => provider.getTracer('http-fixture').startActiveSpan(name, { kind: SpanKind.SERVER, attributes: { 'mikka.route': '/api/fixture' } }, async span => {
    try { return await work() } finally { span.end() }
  }))
}
async function finished() { await provider.forceFlush(); return memory.getFinishedSpans() }

test('real fetch has a correlated client span and preserves the complete HTTP request and response', async () => {
  memory.reset(); requests.length = 0
  handler = (request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => { requests.push({ url: request.url!, headers: request.rawHeaders, body }); response.end('PRIVATE_RESPONSE') })
  }
  const carrier = '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01'
  await parent('request', () => withTraceMetadata({ runId: 'PRIVATE_RUN_ID' }, async () => {
    const response = await fetch(`${origin}/PRIVATE_PATH?access_token=PRIVATE_QUERY`, {
      method: 'POST', headers: { authorization: 'Bearer PRIVATE_TOKEN', cookie: 'session=PRIVATE_COOKIE', traceparent: carrier }, body: 'PRIVATE_BODY',
    })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'PRIVATE_RESPONSE')
  }))
  const spans = await finished()
  const root = spans.find(span => span.kind === SpanKind.SERVER)!
  const clients = spans.filter(span => span.kind === SpanKind.CLIENT)
  assert.equal(clients.length, 1)
  const [client] = clients
  assert.equal(client.parentSpanContext?.spanId, root.spanContext().spanId)
  assert.equal(client.spanContext().traceId, root.spanContext().traceId)
  assert.equal(client.attributes['mikka.route'], '/api/fixture')
  assert.equal(client.attributes['http.request.method'], 'POST')
  assert.equal(client.attributes['http.response.status_code'], 200)
  assert.equal(client.attributes['mikka.http.peer'], 'other')
  assert.equal(client.attributes['mikka.http.outcome'], 'completed')
  assert.equal(client.status.code, SpanStatusCode.UNSET)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/PRIVATE_PATH?access_token=PRIVATE_QUERY')
  assert.equal(requests[0].body, 'PRIVATE_BODY')
  const headers = requests[0].headers
  assert.equal(headers.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'traceparent').length, 1)
  assert.equal(headers[headers.findIndex(value => value.toLowerCase() === 'traceparent') + 1], carrier)
  assert.equal(headers.some((value, index) => index % 2 === 0 && value.toLowerCase().startsWith('x-mikka-trace-')), false)
  const payload = JSON.stringify({ name: client.name, attributes: client.attributes, events: client.events, status: client.status })
  assert.doesNotMatch(payload, /PRIVATE_(?:PATH|QUERY|TOKEN|COOKIE|BODY|RESPONSE)|127\.0\.0\.1/)
  for (const key of ['url.full', 'url.path', 'url.query', 'http.url', 'http.target', 'server.address', 'user_agent.original']) assert.equal(client.attributes[key], undefined)
})

test('unparented requests and SDK-suppressed fetches produce no client spans', async () => {
  memory.reset()
  handler = (_request, response) => response.end('ok')
  await context.with(ROOT_CONTEXT, async () => { assert.equal(await (await fetch(origin)).text(), 'ok') })
  await parent('suppressed', () => context.with(suppressTracing(context.active()), async () => { assert.equal(await (await fetch(origin)).text(), 'ok') }))
  assert.equal((await finished()).filter(span => span.kind === SpanKind.CLIENT).length, 0)
})

test('response headers timing stays separate from a streaming body lifetime', async () => {
  memory.reset()
  let finishBody!: () => void
  handler = (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: first\n\n')
    finishBody = () => response.end('data: last\n\n')
  }
  await parent('stream', async () => {
    const response = await fetch(origin)
    const reader = response.body!.getReader()
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n')
    await new Promise(resolve => setTimeout(resolve, 40))
    finishBody()
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: last\n\n')
    assert.equal((await reader.read()).done, true)
  })
  const client = (await finished()).find(span => span.kind === SpanKind.CLIENT)!
  const headersMs = client.attributes['mikka.http.response_headers_ms']
  assert.equal(typeof headersMs, 'number')
  const durationMs = client.duration[0] * 1000 + client.duration[1] / 1e6
  assert.ok(durationMs - Number(headersMs) >= 30)
  assert.equal(client.attributes['mikka.http.outcome'], 'completed')
  assert.equal(client.attributes['mikka.http.ttfb_ms'], undefined)
})

test('HTTP failures and a broken transport preserve responses and emit bounded failure attributes', async () => {
  memory.reset()
  handler = (request, response) => {
    if (request.url === '/broken') { request.socket.destroy(); return }
    response.writeHead(503, { 'set-cookie': 'PRIVATE_RESPONSE_COOKIE' })
    response.end('PRIVATE_ERROR_BODY')
  }
  await parent('http-failure', async () => {
    const response = await fetch(origin)
    assert.equal(response.status, 503)
    assert.equal(await response.text(), 'PRIVATE_ERROR_BODY')
  })
  await parent('transport-failure', async () => { await assert.rejects(fetch(`${origin}/broken`)) })
  const clients = (await finished()).filter(span => span.kind === SpanKind.CLIENT)
  assert.equal(clients.length, 2)
  const failed = clients.find(span => span.attributes['http.response.status_code'] === 503)!
  assert.equal(failed.status.code, SpanStatusCode.ERROR)
  assert.equal(failed.attributes['error.type'], '503')
  assert.equal(failed.attributes['mikka.http.outcome'], 'http_error')
  const broken = clients.find(span => span !== failed)!
  assert.equal(broken.status.code, SpanStatusCode.ERROR)
  assert.equal(broken.attributes['mikka.http.outcome'], 'transport_error')
  assert.equal(broken.attributes['error.type'], 'UND_ERR_SOCKET')
  assert.doesNotMatch(JSON.stringify(clients.map(span => ({ name: span.name, attributes: span.attributes, status: span.status, events: span.events }))), /PRIVATE_|127\.0\.0\.1/)
})

test('caller abort is distinct from timeout, and neither is reported as completed', async () => {
  memory.reset()
  handler = (_request, response) => { response.writeHead(200); response.flushHeaders() }
  await parent('abort', async () => {
    const controller = new AbortController()
    const response = await fetch(origin, { signal: controller.signal })
    controller.abort()
    await assert.rejects(response.text())
  })
  await parent('timeout', async () => {
    const response = await fetch(origin, { signal: AbortSignal.timeout(150) })
    await assert.rejects(response.text())
  })
  const spans = await finished()
  for (const outcome of ['aborted', 'timeout']) {
    const child = spans.find(span => span.kind === SpanKind.CLIENT && span.attributes['mikka.http.outcome'] === outcome)!
    assert.ok(child, `missing ${outcome} client span`)
    assert.equal(child.status.code, outcome === 'aborted' ? SpanStatusCode.UNSET : SpanStatusCode.ERROR)
    assert.equal(child.attributes['error.type'], outcome === 'aborted' ? undefined : 'timeout')
  }
  // A client attempt's failure does not overwrite the incoming request's outcome.
  assert.ok(spans.filter(span => span.kind === SpanKind.SERVER).every(span => span.status.code === SpanStatusCode.UNSET))
})

test('redirect attempts and concurrent requests retain their original parent', async () => {
  memory.reset()
  handler = (request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: '/PRIVATE_DESTINATION' }); response.end(); return }
    response.end('ok')
  }
  await Promise.all(['first', 'second'].map(name => parent(name, async () => {
    assert.equal(await (await fetch(`${origin}/redirect`)).text(), 'ok')
  })))
  const spans = await finished()
  for (const root of spans.filter(span => span.kind === SpanKind.SERVER)) {
    const clients = spans.filter(span => span.kind === SpanKind.CLIENT && span.parentSpanContext?.spanId === root.spanContext().spanId)
    assert.equal(clients.length, 2)
    assert.deepEqual(clients.map(span => span.attributes['http.response.status_code']).sort(), [200, 302])
    assert.ok(clients.every(span => span.spanContext().traceId === root.spanContext().traceId))
  }
  assert.doesNotMatch(JSON.stringify(spans.map(span => span.attributes)), /PRIVATE_DESTINATION/)
})

test('only exact known or configured origins produce closed peer labels', () => {
  const env = { MIKKA_EVE_ORIGIN: 'http://private-eve.invalid:3002', MIKKA_CLOUD_URL: 'https://private-cloud.invalid/mikka/cloud', MIKKA_LITELLM_URL: 'https://private-models.invalid/v1' }
  for (const [origin, expected] of [
    ['https://api.github.com', 'github'], ['https://backend.composio.dev', 'composio'],
    ['http://private-eve.invalid:3002', 'eve'], ['https://private-cloud.invalid', 'cloud'], ['https://private-models.invalid', 'litellm'],
    ['https://api.github.com.evil.invalid', 'other'], ['http://api.github.com', 'other'], ['https://api.github.com:444', 'other'],
    ['https://tenant-private.invalid', 'other'], ['PRIVATE_INVALID_ORIGIN', 'other'],
  ]) assert.equal(httpTracePeer(origin, env), expected)
  assert.equal(httpTracePeer('https://tenant-private.invalid', { MIKKA_CLOUD_URL: 'PRIVATE_INVALID_CONFIG' }), 'other')
})
