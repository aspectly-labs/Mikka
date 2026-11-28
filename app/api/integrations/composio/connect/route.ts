import { RouteResponse } from '@/lib/server-runtime/server'
import { auth, authBaseURL } from '@/lib/auth'
import { BASE_PATH, withBasePath } from '@/lib/base-path'
import { getComposio } from '@/lib/composio'
import { isComposioCallbackVerifierConfigured } from '@/lib/composio-config'
import { composioConnectRedirect } from '@/lib/composio-accounts'
import { COMPOSIO_FLOW_COOKIE, composioFlowCookieOptions, encodeComposioFlow } from '@/lib/composio-flow'
import { claimComposioConnectIntent, linkComposioConnectIntent, linkedComposioConnectIntent, readComposioConnectIntent } from '@/lib/composio-connect-intent'
import { pool } from '@/lib/db'
import { withRequestLog } from '@/lib/request-log'
import { defineRoute } from '@/lib/primitives/define-route'

/**
 * What the desktop app opens in the system browser for a Composio link:
 * `?intent=` from POST /api/integrations/composio/connect/intent. The token is
 * one use, so the first claim wins the browser session; it alone binds the
 * link to the app's account — so the browser must be signed in as that
 * account before anything starts: a link handed to someone else would link
 * their provider account to the app's account. Once it is, the whole flow
 * lands directly on the provider, and every answer the app can hear ends as a
 * redirect to the loopback it named (RFC 8252 §7.3).
 */
function pluginsFailed(request: Request) {
  return RouteResponse.redirect(new URL(withBasePath('/?settings=integrations&composio=callback-failed'), request.url))
}

function loopbackResult(intent: { returnTo: string; returnState: string }, result: 'connected' | 'failed' | 'cancelled') {
  const url = new URL(intent.returnTo)
  url.searchParams.set('state', intent.returnState)
  url.searchParams.set('result', result)
  return RouteResponse.redirect(url)
}

async function handleGET(request: Request) {
  const token = new URL(request.url).searchParams.get('intent')
  const intent = await readComposioConnectIntent(pool, token)
  const back = () => intent ? loopbackResult(intent, 'failed') : pluginsFailed(request)
  if (!intent) return pluginsFailed(request)
  // The browser must be this link's account before Composio starts; claim
  // only afterwards, so a sign-in round trip can still spend the token.
  const session = await auth.api.getSession({ headers: request.headers })
  if (session?.user?.id !== intent.userId) {
    const url = new URL(request.url)
    const next = `${url.pathname.startsWith(BASE_PATH) ? url.pathname.slice(BASE_PATH.length) : url.pathname}${url.search}`
    // A signed-in but different account stays on the sign-in page to switch
    // (addAccount suppresses the automatic return that would loop forever).
    const signin = `/sign-in?next=${encodeURIComponent(next)}${session?.user ? '&addAccount=1' : ''}`
    return RouteResponse.redirect(new URL(withBasePath(signin), request.url))
  }
  const claimed = await claimComposioConnectIntent(pool, token)
  if (!claimed) {
    // A sign-in round trip navigates here twice at once; the request that
    // loses the claim re-reads the link its twin just recorded instead of
    // reporting a spent token.
    const again = await linkedComposioConnectIntent(pool, intent.tokenHash)
    if (again?.providerUrl && composioConnectRedirect(again.providerUrl)) return RouteResponse.redirect(again.providerUrl)
    return back()
  }
  const composio = getComposio()
  if (!composio || !isComposioCallbackVerifierConfigured(authBaseURL, BASE_PATH)) return loopbackResult(claimed, 'failed')
  try {
    const session = await composio.create(claimed.userId)
    const connection = await session.authorize(claimed.toolkit)
    const redirect = composioConnectRedirect(connection.redirectUrl)
    if (!redirect) return loopbackResult(claimed, 'failed')
    // The link's connected account id lets the callback find this intent even
    // when a browser drops the flow cookie; a forged one can only name a link
    // Composio itself issued for this intent's user.
    await linkComposioConnectIntent(pool, claimed.tokenHash, connection.id, redirect.toString())
    const response = RouteResponse.redirect(redirect)
    response.cookies.set(COMPOSIO_FLOW_COOKIE, encodeComposioFlow({ link: connection.id }), composioFlowCookieOptions(request.url, 600))
    return response
  } catch {
    return loopbackResult(claimed, 'failed')
  }
}

const unguardedGET = withRequestLog('/api/integrations/composio/connect', handleGET)
export const GET = defineRoute(
  {
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  ({ request }) => unguardedGET(request),
)
