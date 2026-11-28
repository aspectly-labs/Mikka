import { channel } from 'node:diagnostics_channel'
import { context, isSpanContextValid, SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api'
import { isTracingSuppressed } from '@opentelemetry/core'
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { httpTracePeer } from '@/lib/env/hosts'

type Request = { method: string; origin: string | URL }
type Message = { request: Request; response?: { statusCode: number }; error?: unknown }
type Pending = { span: Span; started: number; status?: number }
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH', 'QUERY'])
const ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED', 'UND_ERR_DESTROYED', 'UND_ERR_HEADERS_OVERFLOW',
  'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
])

/**
 * Observe native fetch/Undici attempts without wrapping fetch, consuming bodies,
 * or injecting headers. The global propagator contains internal Mikka metadata;
 * automatic injection into arbitrary third parties would cross that boundary.
 */
export class HttpClientTracing implements SpanProcessor {
  private readonly pending = new WeakMap<Request, Pending>()
  private readonly subscriptions: { name: string; receive: (message: unknown) => void }[] = []

  constructor() {
    this.subscribe('undici:request:create', ({ request }) => {
      const parent = context.active()
      const active = trace.getSpan(parent)
      if (isTracingSuppressed(parent) || !active?.isRecording() || !isSpanContextValid(active.spanContext())) return
      const method = METHODS.has(request.method) ? request.method : '_OTHER'
      const span = trace.getTracer('mikka.http-client').startSpan(method === '_OTHER' ? 'HTTP' : method, {
        kind: SpanKind.CLIENT,
        attributes: { 'http.request.method': method, 'mikka.http.peer': httpTracePeer(request.origin), 'mikka.http.transport': 'undici' },
      }, parent)
      this.pending.set(request, { span, started: performance.now() })
    })
    this.subscribe('undici:request:headers', ({ request, response }) => {
      const pending = this.pending.get(request)
      if (!pending || !response || response.statusCode < 200) return
      pending.status = response.statusCode
      pending.span.setAttributes({ 'http.response.status_code': response.statusCode, 'mikka.http.response_headers_ms': Math.max(0, performance.now() - pending.started) })
      if (response.statusCode >= 400) {
        pending.span.setAttribute('error.type', String(response.statusCode))
        pending.span.setStatus({ code: SpanStatusCode.ERROR })
      }
    })
    this.subscribe('undici:request:trailers', ({ request }) => this.finish(request))
    this.subscribe('undici:request:error', ({ request, error }) => this.finish(request, error))
  }

  private subscribe(name: string, work: (message: Message) => void): void {
    const receive = (message: unknown) => {
      try { work(message as Message) } catch { /* diagnostic subscribers run inside the transport and must never throw */ }
    }
    channel(name).subscribe(receive)
    this.subscriptions.push({ name, receive })
  }

  private finish(request: Request, error?: unknown): void {
    const pending = this.pending.get(request)
    if (!pending) return
    this.pending.delete(request)
    const { span } = pending
    let outcome = pending.status && pending.status >= 400 ? 'http_error' : 'completed'
    if (error !== undefined) {
      const fields = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown } : {}
      const aborted = fields.name === 'AbortError' || fields.code === 'UND_ERR_ABORTED'
      // Undici tells us that the caller aborted, not why. Keep a separate
      // outcome; never infer an end-user disconnect or a successful operation.
      if (aborted) outcome = 'aborted'
      else {
        const code = typeof fields.code === 'string' && ERROR_CODES.has(fields.code) ? fields.code : undefined
        const timeout = fields.name === 'TimeoutError' || code?.includes('TIMEOUT') || code === 'ETIMEDOUT'
        outcome = timeout ? 'timeout' : 'transport_error'
        span.setAttribute('error.type', code ?? outcome)
        span.setStatus({ code: SpanStatusCode.ERROR })
      }
    }
    span.setAttribute('mikka.http.outcome', outcome)
    span.end()
  }

  onStart(): void {}
  onEnd(): void {}
  forceFlush(): Promise<void> { return Promise.resolve() }
  shutdown(): Promise<void> {
    for (const { name, receive } of this.subscriptions) channel(name).unsubscribe(receive)
    this.subscriptions.length = 0
    return Promise.resolve()
  }
}
