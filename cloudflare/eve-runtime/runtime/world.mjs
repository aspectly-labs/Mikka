import { timingSafeEqual } from 'node:crypto'

const no = status => new Response(null, { status, headers: { 'cache-control': 'no-store' } })
const worldMethods = new Map([
  ['/world/rpc', ['POST']], ['/world/run-terminal', ['GET']], ['/world/stream', ['GET', 'DELETE']],
  ['/world/queue/publish', ['POST']], ['/world/queue/claim', ['POST']], ['/world/queue/release', ['POST']],
])

/** Private egress adapter for the queue-driven World. The container's
 * `world.internal` requests carry a capability minted per host; redirects are
 * never followed so the capability cannot leave the intercept. Mirrors the
 * business worker's `businessWorldRequest`. */
export function eveWorldRequest(request, binding, capability) {
  const url = new URL(request.url)
  if (url.origin !== 'https://world.internal' || url.username || url.password || url.hash
      || !worldMethods.get(url.pathname)?.includes(request.method)) return no(404)
  const presented = request.headers.get('x-mikka-world-capability') ?? ''
  if (!capability || presented.length !== capability.length || !/^[a-zA-Z0-9-]+$/.test(presented)
      || !timingSafeEqual(new TextEncoder().encode(presented), new TextEncoder().encode(capability))) return no(403)
  if (!binding) return no(503)
  const headers = new Headers()
  for (const name of ['accept', 'content-type']) if (request.headers.has(name)) headers.set(name, request.headers.get(name))
  if (request.headers.get('accept-encoding') === 'identity') headers.set('accept-encoding', 'identity')
  return binding.fetch(new Request(request, { headers, redirect: 'manual' }))
}
