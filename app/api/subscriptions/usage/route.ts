import { defineRoute } from '@/lib/primitives/define-route'
import { subscriptionUsage } from '@/lib/subscription-http'
import { subscriptionHTTPDependencies } from '@/lib/subscription-http-runtime'

export const maxDuration = 30
const subscriptionAuthRequired = () => Response.json(
  { error: 'auth_required' },
  { status: 401, headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } },
)
export const GET = defineRoute(
  { auth: 'session', origin: 'any', workspace: 'none', onAuthFailure: subscriptionAuthRequired },
  ({ request, session }) => subscriptionUsage(request, {
    ...subscriptionHTTPDependencies,
    session: async () => ({ userId: session.user.id, sessionId: session.session.id, tokenWorkspaceId: session.tokenWorkspaceId }),
  }),
)
