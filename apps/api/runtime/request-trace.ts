import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { safeErrorAttributes } from '@mikka/protocol/tracing'
import { routeScope } from '@/lib/tracing/labels'
import { clientKindFor } from '@/lib/tracing/spans'
import { SERVICE_NAME } from '@/lib/tracing/config'
import { criticalRoute } from '@/lib/tracing/sampling'
import { withTraceMetadata } from '@/lib/tracing/context'
import { telemetryId } from '@mikka/protocol/trace-context'

export type RequestTrace = {
  run<T>(callback: () => T): T
  response(response: Response): Response
  finish(status: number, error?: unknown): void
}

/** route is the generated route template, never a concrete path or query. */
export function beginRequestTrace(request: Request, route: string): RequestTrace {
  const started = performance.now()
  // Accept only the standard trace carrier. Baggage and arbitrary incoming
  // headers must not become attributes or propagate into business work.
  const carrier: Record<string, string | undefined> = {
    traceparent: request.headers.get('traceparent') ?? undefined,
    tracestate: request.headers.get('tracestate') ?? undefined,
  }
  // These headers carry only bounded telemetry IDs, never authentication.
  if (route.startsWith('/v1/')) for (const [name, value] of request.headers) {
    if (name.startsWith('x-mikka-trace-') && telemetryId(value)) carrier[name] = value
  }
  const identity = request.headers.get('x-posthog-distinct-id')
  const session = request.headers.get('x-posthog-session-id')
  const metadata = {
    ...(telemetryId(identity) ? { posthogDistinctId: identity } : {}),
    ...(telemetryId(session) ? { sessionId: session } : {}),
  }
  const parent = propagation.extract(ROOT_CONTEXT, carrier)
  const span = trace.getTracer(SERVICE_NAME).startSpan(`${request.method} ${route}`, {
    kind: SpanKind.SERVER,
    attributes: {
      'http.request.method': request.method,
      'http.route': route,
      'url.path': route,
      'mikka.route': route,
      'mikka.client_kind': clientKindFor(route),
      'mikka.trace.critical': criticalRoute(request.method, route),
      ...metadata,
    },
  }, parent)
  const active = trace.setSpan(parent, span)
  let finished = false, streaming = false, bodyFailed = false, bodyError: unknown
  // A server deadline or an upstream AbortError is not proof of user intent.
  // Node's incoming request signal identifies a real client disconnect.
  const requestCancelled = (error: unknown) => {
    if (!request.signal.aborted) return false
    const reason = safeErrorAttributes(request.signal.reason)
    const clientAbort = reason['error.type'] === 'AbortError' || reason['mikka.error.code'] === 'ECONNRESET'
      || reason['mikka.error.code'] === 'ERR_STREAM_PREMATURE_CLOSE'
    return clientAbort && (error === undefined || error === request.signal.reason || (error instanceof Error && error.name === 'AbortError'))
  }
  return {
    run: callback => context.with(active, () => withTraceMetadata(metadata, () => routeScope.run(route, callback))),
    response(response) {
      if (!span.isRecording()) return response
      const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      const kind = contentType === 'text/event-stream' ? 'event_stream' : contentType === 'application/x-ndjson' ? 'ndjson' : 'regular'
      streaming = kind !== 'regular'
      span.setAttributes({ 'mikka.http.response_kind': kind, 'mikka.http.response_headers_ms': performance.now() - started })
      if (!streaming || !response.body) return response
      const reader = response.body.getReader()
      let firstByte = false, closed = false
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read()
            if (closed) return
            if (chunk.done) { closed = true; controller.close(); reader.releaseLock(); return }
            if (!firstByte && chunk.value.byteLength > 0) {
              firstByte = true
              span.setAttribute('mikka.http.ttfb_ms', performance.now() - started)
            }
            controller.enqueue(chunk.value)
          } catch (error) {
            if (closed) return
            closed = true
            // Capture upstream failure before socket disposal can also abort
            // the incoming signal and otherwise disguise it as cancellation.
            if (!requestCancelled(error)) { bodyFailed = true; bodyError = error }
            controller.error(error)
            reader.releaseLock()
          }
        },
        async cancel(reason) {
          closed = true
          try { await reader.cancel(reason) } finally { reader.releaseLock() }
        },
      }, { highWaterMark: 0 })
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    },
    // H3's actual response-disposal boundary calls this before running after
    // jobs. Ending at handler return would truncate streaming requests; holding
    // the span through after jobs would misattribute their own detached spans.
    finish(status, error) {
      if (finished) return
      finished = true
      span.setAttribute('http.response.status_code', status)
      const cancelled = streaming && status >= 200 && status < 300 && !bodyFailed && requestCancelled(error)
      const failure = bodyFailed ? bodyError : error
      const failed = status >= 500 || bodyFailed || (failure !== undefined && !cancelled)
      span.setAttribute('mikka.http.outcome', failed ? 'error' : cancelled ? 'client_cancelled' : 'completed')
      if (failed && failure !== undefined) span.setAttributes(safeErrorAttributes(failure))
      if (failed) span.setStatus({ code: SpanStatusCode.ERROR })
      span.end()
    },
  }
}
