import { subscriptionChatPath, subscriptionChatUrl } from '../../litellm/subscription-chat.mjs'

// The private service binding carries the original URL. Construct proxy
// authority from the configured public origin, never from a caller header.
export function apiRequest(request, origin) {
  const url = new URL(request.url)
  if (url.origin !== origin || url.protocol !== 'https:') return null
  const outbound = new Request(request, { redirect: 'manual' })
  const ip = outbound.headers.get('cf-connecting-ip')
  for (const key of request.headers.keys()) {
    if (key === 'x-mikka-eve-scope' || key === 'x-mikka-eve-binding-scope' || key === 'forwarded' || key === 'x-real-ip' || key === 'cf-connecting-ip'
      || key === 'cf-container-target-port' || key.startsWith('x-forwarded-')
      || key.startsWith('x-vercel-') || key.startsWith('x-mikka-edge-')) outbound.headers.delete(key)
  }
  outbound.headers.set('host', url.host)
  outbound.headers.set('x-forwarded-host', url.host)
  outbound.headers.set('x-forwarded-proto', 'https')
  if (ip) outbound.headers.set('x-mikka-edge-ip', ip)
  return outbound
}

export function subscriptionChatToApi(request, origin, send) {
  if (request.method !== 'POST' || request.url !== subscriptionChatUrl) return new Response(null, { status: 404 })
  const url = new URL(subscriptionChatPath, origin)
  const forwarded = apiRequest(new Request(url, { method: 'POST', body: request.body, duplex: 'half', redirect: 'manual',
    headers: { 'content-type': 'application/json' } }), origin)
  return forwarded ? send(forwarded) : new Response(null, { status: 400 })
}
