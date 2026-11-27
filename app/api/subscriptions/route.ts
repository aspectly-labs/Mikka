import { freshSessionRoute } from '@/lib/fresh-session'
import { defineRoute } from '@/lib/primitives/define-route'
import { subscriptionHTTP, subscriptionList } from '@/lib/subscription-http'
import { subscriptionHTTPDependencies } from '@/lib/subscription-http-runtime'

export const maxDuration = 60
const subscriptionHeaders = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } as const
const subscriptionAuthRequired = () => Response.json({ error: 'auth_required' }, { status: 401, headers: subscriptionHeaders })
const subscriptionOriginRefused = () => Response.json({ error: 'request_refused' }, { status: 403, headers: subscriptionHeaders })

const POSTBody = defineRoute(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    route: '/api/subscriptions',
    onOriginFailure: subscriptionOriginRefused,
    onAuthFailure: subscriptionAuthRequired,
    desktop: true,
  },
  ({ request, session }) => subscriptionHTTP({
    ...subscriptionHTTPDependencies,
    session: async () => ({ userId: session.user.id, sessionId: session.session.id, tokenWorkspaceId: session.tokenWorkspaceId }),
  })(request),
)
export const GET = defineRoute(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'none',
    route: '/api/subscriptions',
    onAuthFailure: subscriptionAuthRequired,
    desktop: true,
  },
  ({ request, session }) => subscriptionList(request, {
    ...subscriptionHTTPDependencies,
    session: async () => ({ userId: session.user.id, sessionId: session.session.id, tokenWorkspaceId: session.tokenWorkspaceId }),
  }),
)

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
