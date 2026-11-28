import { withRequestLog } from '@/lib/request-log'
import { RouteResponse } from '@/lib/server-runtime/server'
import { cookies } from '@/lib/server-runtime/headers'
import { requireUser } from '@/lib/issue-access'
import { exchangeLinearCode, stateCookieOptions, LINEAR_OAUTH_STATE_COOKIE } from '@/lib/linear-sync/oauth'
import { withBasePath } from '@/lib/base-path'
import { defineRoute } from '@/lib/primitives/define-route'


async function handleGET(request: Request) {
  const url = new URL(request.url)
  const failure = new URL(withBasePath('/?linear=error'), url.origin)
  const cookieStore = await cookies()
  const redirect = (destination: URL) => {
    const response = RouteResponse.redirect(destination)
    response.cookies.set(LINEAR_OAUTH_STATE_COOKIE, '', stateCookieOptions(0))
    return response
  }
  if (url.searchParams.has('error')) return redirect(failure)
  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code')
  if (!state || !code || state.length > 256 || code.length > 2048 || cookieStore.get(LINEAR_OAUTH_STATE_COOKIE)?.value !== state) return redirect(failure)
  try {
    const user = await requireUser()
    await exchangeLinearCode(state, code, user.id)
    return redirect(new URL(withBasePath('/?linear=connected'), url.origin))
  } catch {
    return redirect(failure)
  }
}

const unguardedGET = withRequestLog('/api/integrations/linear/callback', handleGET)
export const GET = defineRoute(
  {
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  ({ request }) => unguardedGET(request),
)
