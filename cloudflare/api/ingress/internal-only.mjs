import { subscriptionChatPath } from '../../litellm/subscription-chat.mjs'
import { releaseRoutePath } from '../../web/route-path.mjs'

/** API routes the public edge never forwards, whatever the method. They are
 * reached only over a service binding (subscription chat: LiteLLM's
 * `subscriptionChat` RPC). The ingress worker answers 404 for them, and the
 * staging route probe asserts that 404 (scripts/ops/route-probe.mjs). */
export const internalOnlyRoutes = Object.freeze([subscriptionChatPath])

/** True when the public edge must answer 404 for this pathname. Compares the
 * release route form, so percent-encoded unreserved characters and a trailing
 * slash cannot reach the route. */
export function internalOnlyPath(pathname) {
  const path = releaseRoutePath(pathname)
  return internalOnlyRoutes.some(route => path === route || path === route + '/')
}
