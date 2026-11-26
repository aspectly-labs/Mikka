import { withBasePath } from '@/lib/base-path'
import { createLinearAuthorizationUrl, LINEAR_OAUTH_STATE_COOKIE, stateCookieOptions } from '@/lib/linear-sync/oauth'
import { defineRoute } from '@/lib/primitives/define-route'
import { RouteResponse } from '@/lib/server-runtime/server'

export const GET = defineRoute(
  { route: '/api/integrations/linear/connect', auth: 'human-session-only', origin: 'any', workspace: 'none' },
  async ({ request, user }) => {
    const url = new URL(request.url)
    const failed = () => RouteResponse.redirect(new URL(withBasePath('/?linear=error'), url.origin))
    if (url.searchParams.get('account') !== user.id || request.headers.get('sec-fetch-site') === 'cross-site') return failed()
    try {
      const grant = await createLinearAuthorizationUrl(user.id)
      const response = RouteResponse.redirect(grant.url)
      response.headers.set('cache-control', 'no-store')
      response.headers.set('referrer-policy', 'no-referrer')
      response.cookies.set(LINEAR_OAUTH_STATE_COOKIE, grant.state, stateCookieOptions(600))
      return response
    } catch {
      return failed()
    }
  },
)
