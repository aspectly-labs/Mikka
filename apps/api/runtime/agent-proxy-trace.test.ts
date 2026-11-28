import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api'
import { AlwaysOnSampler, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { serve } from 'srvx/node'
import { proxyEveRequest } from '../../../lib/eve-service-proxy'
import { RouteAttributesProcessor } from '../../../lib/tracing/spans'
import { sanitizeSpan } from '../../../lib/tracing/sanitize'
import { createApiHandler } from '../src/application'
import { beginRequestTrace } from './request-trace'

const memory = new InMemorySpanExporter()
const provider = new NodeTracerProvider({ sampler: new AlwaysOnSampler(), spanProcessors: [new RouteAttributesProcessor(), new SimpleSpanProcessor(memory)] })
before(() => provider.register())
after(async () => { await provider.shutdown(); trace.disable(); context.disable(); propagation.disable() })

/** The actual Node ingress and H3 disposal boundary, with only Eve's HTTP
 * boundary replaced. No database, provider credential or model invocation. */
async function proxyApplication(upstream: typeof fetch) {
  memory.reset()
  const finished = Promise.withResolvers<void>()
  let original!: Request, active!: ReadableSpan, finishes = 0
  const app = createApiHandler([{
    path: '/mikka/api/agents/[...path]', template: '/api/agents/[...path]', source: 'agent-proxy-fixture', methods: ['GET'],
    load: async () => ({ GET: async (request: Request) => {
      active = trace.getActiveSpan() as unknown as ReadableSpan
      return proxyEveRequest(request, undefined, { fetch: upstream })
    } }),
  }], (request, route) => {
    original = request
    const current = beginRequestTrace(request, route)
    return { ...current, finish(status, error) { current.finish(status, error); finishes++; finished.resolve() } }
  })
  const runtime = serve({ manual: true, gracefulShutdown: false, silent: true, trustProxy: false,
    hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) })
  const server = createServer(runtime.node!.handler)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    get request() { return original },
    get active() { return active },
    async fetch(suffix = '/stream') {
      return fetch(`http://127.0.0.1:${address.port}/mikka/api/agents/eve/v1/session/private-session${suffix}?token=private-query`, {
        headers: { authorization: 'Bearer private-bearer', cookie: 'session=private-cookie' },
      })
    },
    async span() {
      await finished.promise
      await provider.forceFlush()
      assert.equal(finishes, 1)
      const [span] = memory.getFinishedSpans().map(sanitizeSpan)
      assert.ok(span)
      assert.equal(span.name, 'GET /api/agents/[...path]')
      assert.equal(span.attributes['http.route'], '/api/agents/[...path]')
      assert.doesNotMatch(JSON.stringify({ attributes: span.attributes, events: span.events, status: span.status }), /private-|127\.0\.0\.1/)
      return span
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await runtime.close()
    },
  }
}

test('a non-stream Eve connection failure retains its safe cause code while the caller gets the existing 503', { timeout: 5_000 }, async () => {
  const upstream = Object.assign(new Error('private-origin private-cookie'), { code: 'ECONNREFUSED' })
  const app = await proxyApplication(async () => { throw new TypeError('private-fetch-url?token=private-query', { cause: upstream }) })
  try {
    const response = await app.fetch('')
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { ok: false, error: 'coordinatorUnavailable' })
    const span = await app.span()
    assert.equal(span.status.code, SpanStatusCode.ERROR)
    assert.equal(span.attributes['http.response.status_code'], 503)
    assert.equal(span.attributes['mikka.error.code'], 'ECONNREFUSED')
    assert.equal(span.attributes['error.type'], 'TypeError')
    assert.equal(span.attributes['mikka.eve.route'], '/eve/v1/session/[sessionId]')
    assert.equal(span.attributes['mikka.http.response_kind'], 'regular')
    assert.equal(span.attributes['mikka.http.outcome'], 'error')
    assert.equal(app.request.signal.aborted, false)
  } finally { await app.close() }
})

test('an upstream HTTP 503 keeps its status without exporting its response body or headers', { timeout: 5_000 }, async () => {
  const app = await proxyApplication(async () => new Response('private-upstream-body', { status: 503, headers: { 'x-private': 'private-header' } }))
  try {
    const response = await app.fetch('/private-action')
    assert.equal(response.status, 503)
    assert.equal(await response.text(), 'private-upstream-body')
    const span = await app.span()
    assert.equal(span.status.code, SpanStatusCode.ERROR)
    assert.equal(span.attributes['mikka.http.outcome'], 'error')
    assert.equal(span.attributes['mikka.eve.route'], '/eve/v1/[...path]')
    assert.equal(span.attributes['mikka.error.code'], undefined)
  } finally { await app.close() }
})

for (const [contentType, kind] of [['application/x-ndjson', 'ndjson'], ['text/event-stream; charset=utf-8', 'event_stream']] as const) {
  for (const outcome of ['complete', 'cancel', 'error', 'upstream_abort', 'upstream_timeout'] as const) {
    test(`${kind} ${outcome} separates first byte from disposal and preserves real upstream failures`, { timeout: 5_000 }, async () => {
      let source!: ReadableStreamDefaultController<Uint8Array>, upstreamSignal: AbortSignal | null | undefined, sourceCancelled = false
      const app = await proxyApplication(async (_input, init) => {
        upstreamSignal = init?.signal
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { source = controller; controller.enqueue(new TextEncoder().encode('private-stream-content\n')) },
          cancel() { sourceCancelled = true },
        }), { headers: { 'content-type': contentType } })
      })
      try {
        const response = await app.fetch()
        assert.equal(response.status, 200)
        const reader = response.body!.getReader()
        assert.equal(new TextDecoder().decode((await reader.read()).value), 'private-stream-content\n')
        // The first-byte value must exist while the stream is still open.
        const firstByte = app.active.attributes['mikka.http.ttfb_ms']
        assert.equal(memory.getFinishedSpans().length, 0)
        assert.equal(app.request.signal.aborted, false)
        if (outcome === 'complete') { source.close(); assert.equal((await reader.read()).done, true) }
        else if (outcome === 'cancel') await reader.cancel()
        else {
          const error = outcome === 'upstream_abort' ? new DOMException('private-abort', 'AbortError')
            : outcome === 'upstream_timeout' ? new DOMException('private-timeout', 'TimeoutError')
              : Object.assign(new Error('private-upstream-failure'), { code: 'ECONNRESET' })
          source.error(error)
          await assert.rejects(reader.read())
        }
        const span = await app.span()
        const failed = !['complete', 'cancel'].includes(outcome)
        assert.equal(span.status.code, failed ? SpanStatusCode.ERROR : SpanStatusCode.UNSET, JSON.stringify({
          signalAborted: app.request.signal.aborted, reason: app.request.signal.reason?.name, attributes: span.attributes,
        }))
        assert.equal(span.attributes['http.response.status_code'], 200)
        if (outcome === 'error') assert.equal(span.attributes['mikka.error.code'], 'ECONNRESET')
        if (outcome === 'upstream_abort') assert.equal(span.attributes['error.type'], 'AbortError')
        if (outcome === 'upstream_timeout') assert.equal(span.attributes['error.type'], 'TimeoutError')
        assert.equal(typeof firstByte, 'number')
        assert.equal(span.attributes['mikka.eve.route'], '/eve/v1/session/[sessionId]/stream')
        assert.equal(span.attributes['mikka.http.response_kind'], kind)
        assert.equal(span.attributes['mikka.http.outcome'], failed ? 'error' : outcome === 'cancel' ? 'client_cancelled' : 'completed')
        assert.equal(span.attributes['mikka.http.ttfb_ms'], firstByte)
        assert.ok(Number(firstByte) >= Number(span.attributes['mikka.http.response_headers_ms']))
        if (outcome === 'cancel') { assert.equal(sourceCancelled, true); assert.equal(upstreamSignal?.aborted, true); assert.equal(app.request.signal.aborted, true) }
        if (!failed) assert.equal(span.attributes['error.type'], undefined)
      } finally { await app.close() }
    })
  }
}

test('non-Eve streams preserve reader demand and cancellation without inventing first-byte timing for empty content', async () => {
  for (const emptyChunk of [false, true]) {
    memory.reset()
    let pulls = 0, cancellations = 0
    const reason = new DOMException('fixture cancellation', 'AbortError')
    const current = beginRequestTrace(new Request('https://app.test/api/fixture/events'), '/api/fixture/events')
    const response = current.response(new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        if (emptyChunk) controller.enqueue(new Uint8Array())
        else controller.close()
      },
      cancel(cause) { cancellations++; assert.equal(cause, reason) },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } }))
    await Promise.resolve()
    assert.equal(pulls, 0, 'observing a stream must not pull before its consumer')
    const reader = response.body!.getReader()
    const chunk = await reader.read()
    assert.equal(chunk.done, !emptyChunk)
    if (emptyChunk) assert.equal(chunk.value?.byteLength, 0)
    await Promise.resolve()
    assert.equal(pulls, 1, 'the observer must not read ahead of the consumer')
    if (emptyChunk) await reader.cancel(reason)
    assert.equal(cancellations, emptyChunk ? 1 : 0)
    current.finish(200)
    await provider.forceFlush()
    const [span] = memory.getFinishedSpans().map(sanitizeSpan)
    assert.equal(span.attributes['http.route'], '/api/fixture/events')
    assert.equal(span.attributes['mikka.http.response_kind'], 'event_stream')
    assert.equal(span.attributes['mikka.http.ttfb_ms'], undefined)
    assert.equal(span.attributes['mikka.eve.route'], undefined)
  }
})
