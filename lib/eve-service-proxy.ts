import { channel } from 'node:diagnostics_channel'
import { trace } from '@opentelemetry/api'
import { DEFAULT_LOCAL_EVE_ORIGIN } from '@/lib/env/hosts'
import { runtimeEnv } from '@/lib/env/server'

/** The eve service owns its protocol and authentication. This proxy supplies
 * the app's same-origin mount without interpreting or buffering its events. */
export const EVE_PUBLIC_PREFIX = '/mikka/api/agents'

export function eveServiceOrigin(env: Record<string, string | undefined> = runtimeEnv()): URL {
  const value = env.MIKKA_EVE_ORIGIN ?? DEFAULT_LOCAL_EVE_ORIGIN
  const origin = new URL(value)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('EVE_SERVICE_ORIGIN_INVALID')
  return origin
}

const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']
const requestErrorChannel = channel('mikka.request.error')

/** Closed templates only: session IDs and unknown Eve paths stay private. */
function eveRouteTemplate(path: string): string {
  if (path === '/eve/v1/session') return path
  const session = /^\/eve\/v1\/session\/[^/]+(?:\/(stream|cancel|end|approval))?$/.exec(path)
  if (session) return `/eve/v1/session/[sessionId]${session[1] ? `/${session[1]}` : ''}`
  return path.startsWith('/.well-known/workflow/') ? '/.well-known/workflow/[...path]' : '/eve/v1/[...path]'
}

export function eveProxyPath(request: Request, upstreamPath?: string): string {
  const original = new URL(request.url)
  const path = upstreamPath ?? (original.pathname.startsWith(`${EVE_PUBLIC_PREFIX}/`) ? original.pathname.slice(EVE_PUBLIC_PREFIX.length) : '')
  if (!path.startsWith('/eve/v1/') && !path.startsWith('/.well-known/workflow/')) throw new Error('EVE_PROXY_PATH_INVALID')
  if (/[\\?#]/.test(path) || /%2f|%5c|%2e|\/\.\.?\//i.test(path)) throw new Error('EVE_PROXY_PATH_INVALID')
  return path
}

export async function proxyEveRequest(request: Request, upstreamPath?: string, options: {
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
} = {}): Promise<Response> {
  let target: URL
  let path: string
  try {
    path = eveProxyPath(request, upstreamPath)
    target = new URL(path, eveServiceOrigin(options.env))
    target.search = new URL(request.url).search
  } catch {
    return Response.json({ ok: false, error: 'notFound' }, { status: 404 })
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && /^\/eve\/v1\/session(?:\/|$)/.test(path)
    && request.headers.has('cookie') && !request.headers.has('authorization')) {
    let expectedOrigin: string
    try { expectedOrigin = new URL((options.env ?? runtimeEnv()).BETTER_AUTH_URL ?? request.url).origin }
    catch { return Response.json({ ok: false, error: 'coordinatorUnavailable' }, { status: 503 }) }
    if (request.headers.get('origin') !== expectedOrigin || request.headers.get('sec-fetch-site') === 'cross-site') {
      return Response.json({ ok: false, error: 'originRejected' }, { status: 403, headers: { 'cache-control': 'no-store' } })
    }
  }
  const headers = new Headers(request.headers)
  // Connection can nominate additional hop-by-hop fields.
  for (const name of (headers.get('connection') ?? '').split(',')) if (name.trim()) headers.delete(name.trim())
  for (const name of hopHeaders) headers.delete(name)
  headers.set('x-forwarded-host', new URL(request.url).host)
  headers.set('x-forwarded-proto', new URL(request.url).protocol.slice(0, -1))
  trace.getActiveSpan()?.setAttribute('mikka.eve.route', eveRouteTemplate(path))
  try {
    const response = await (options.fetch ?? fetch)(target, {
      method: request.method, headers, signal: request.signal, redirect: 'manual',
      ...(!['GET', 'HEAD'].includes(request.method) && request.body ? { body: request.body, duplex: 'half' } : {}),
    } as RequestInit)
    const outputHeaders = new Headers(response.headers)
    for (const name of hopHeaders) outputHeaders.delete(name)
    outputHeaders.set('cache-control', 'private, no-store')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outputHeaders })
  } catch (error) {
    if (request.signal.aborted) throw error
    // The existing subscriber keeps only safe error names/codes from the cause
    // chain, on the request span and its correlated failure log.
    try { requestErrorChannel.publish(error) } catch { /* diagnostics never change the response */ }
    // URL, cookie and provider error messages must not enter an error body.
    return Response.json({ ok: false, error: 'coordinatorUnavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } })
  }
}
