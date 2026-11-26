export const subscriptionChatHost = 'subscription-chat.internal'
export const subscriptionChatPath = '/mikka/api/internal/subscription/chat'
export const subscriptionChatUrl = 'https://' + subscriptionChatHost + subscriptionChatPath

const deny = status => new Response(null, { status, headers: { 'cache-control': 'no-store' } })

export async function subscriptionChatRequest(request, binding) {
  if (request.method !== 'POST' || request.url !== subscriptionChatUrl) return deny(404)
  if (!binding) return deny(503)
  const response = await binding.subscriptionChat(new Request(request.url, {
    method: 'POST', body: request.body, duplex: 'half', redirect: 'manual',
    headers: { 'content-type': 'application/json' },
  }))
  if (response.status < 300 || response.status >= 400) return response
  await response.body?.cancel().catch(() => undefined)
  return deny(502)
}
