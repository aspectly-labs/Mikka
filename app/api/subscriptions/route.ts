import { freshSessionRoute } from '@/lib/fresh-session'
import { defineRoute } from '@/lib/primitives/define-route'
import { subscriptionHTTP, subscriptionList } from '@/lib/subscription-http'
import { subscriptionHTTPDependencies } from '@/lib/subscription-http-runtime'

export const maxDuration = 60
const subscriptionAuthRequired = () => Response.json(
  { error: 'auth_required' },
  { status: 401, headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } },
)
const subscriptionPost = subscriptionHTTP(subscriptionHTTPDependencies)
const POSTBody = defineRoute(
  { auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', freshSession: true, route: '/api/subscriptions', onAuthFailure: subscriptionAuthRequired },
  ({ request }) => subscriptionPost(request),
)
export const GET = defineRoute(
  { auth: 'session', origin: 'any', workspace: 'none', route: '/api/subscriptions', onAuthFailure: subscriptionAuthRequired },
  ({ request }) => subscriptionList(request, subscriptionHTTPDependencies),
)

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
