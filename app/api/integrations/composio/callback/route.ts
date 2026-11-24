import { noteLogUser, withRequestLog } from '@/lib/request-log'
import { RouteRequest, RouteResponse } from '@/lib/server-runtime/server'
import { afterJob } from '@/lib/background'
import { auth, authBaseURL } from '@/lib/auth'
import { BASE_PATH, withBasePath } from '@/lib/base-path'
import { getComposio, readComposioAccountEmail, renameComposioAccount, retireComposioAccount } from '@/lib/composio'
import { chooseComposioDefault, listComposioAccountRecords, noteComposioEmailAttempt, saveComposioAccountEmail } from '@/lib/composio-account-store'
import { followUpComposioConnect } from '@/lib/composio-connect'
import { COMPOSIO_FLOW_COOKIE, composioFlowCookieOptions, decodeComposioFlow } from '@/lib/composio-flow'
import { composioConnectIntentByLink } from '@/lib/composio-connect-intent'
import { pool } from '@/lib/db'
import { listComposioPages } from '@/lib/composio-pagination'
import { isComposioCallbackVerifierConfigured } from '@/lib/composio-config'
import { COMPOSIO_AUTH_CALLBACK_PATH } from '@/lib/auth-return'
import { bootstrapSuggestions } from '@/lib/suggestions/sources'

const SESSION_COOKIE = 'mikka_composio_session_uri'
const noStore = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }

function clearSessionCookie(request: RouteRequest, response: RouteResponse) {
  // The same options they were set with, so `secure` matches and the browser drops them.
  for (const name of [SESSION_COOKIE, COMPOSIO_FLOW_COOKIE]) response.cookies.set(name, '', composioFlowCookieOptions(request.url, 0))
  return response
}

/** Back to where the connect started (a validated same-origin path), or Settings › 连接. */
function integrationRedirect(request: RouteRequest, result: string) {
  const returnTo = decodeComposioFlow(request.cookies.get(COMPOSIO_FLOW_COOKIE)?.value)?.returnTo ?? '/?settings=integrations'
  const url = new URL(withBasePath(returnTo), request.url)
  url.searchParams.set('composio', result)
  return RouteResponse.redirect(url)
}

/** A desktop app's answer lands on its own loopback listener (RFC 8252 §7.3), not on a page. */
function loopbackResult(intent: { returnTo: string; returnState: string }, result: 'connected' | 'failed') {
  const url = new URL(intent.returnTo)
  url.searchParams.set('state', intent.returnState)
  url.searchParams.set('result', result)
  return RouteResponse.redirect(url)
}

async function handleGET(request: RouteRequest) {
  if (!isComposioCallbackVerifierConfigured(authBaseURL, BASE_PATH)) {
    return new Response('Composio callback verifier is not configured.', { status: 503, headers: noStore })
  }

  const sessionUri = request.routeUrl.searchParams.get('session_uri') ?? request.cookies.get(SESSION_COOKIE)?.value
  if (!sessionUri || sessionUri.length > 4096) {
    return new Response('Invalid Composio callback.', { status: 400, headers: noStore })
  }

  const session = await auth.api.getSession({ headers: request.headers })
  const flow = decodeComposioFlow(request.cookies.get(COMPOSIO_FLOW_COOKIE)?.value)
  // A desktop link names its account by intent: its callback needs no session
  // of the browser's own, and its answer goes to the app's loopback.
  const intent = flow?.link ? await composioConnectIntentByLink(pool, flow.link) : null

  noteLogUser(session?.user?.id)
  if (!session?.user && !intent) {
    const params = new URLSearchParams({ next: COMPOSIO_AUTH_CALLBACK_PATH })
    const response = RouteResponse.redirect(new URL(withBasePath(`/sign-in?${params}`), request.url))
    response.cookies.set(SESSION_COOKIE, sessionUri, composioFlowCookieOptions(request.url, 600))
    response.headers.set('Cache-Control', noStore['Cache-Control'])
    response.headers.set('Referrer-Policy', noStore['Referrer-Policy'])
    return response
  }

  const back = (result: 'connected' | 'callback-failed', attempt?: { returnTo: string; returnState: string } | null) =>
    attempt ? loopbackResult(attempt, result === 'connected' ? 'connected' : 'failed') : integrationRedirect(request, result)

  const composio = getComposio()
  if (!composio) {
    const response = back('callback-failed', intent)
    clearSessionCookie(request, response)
    response.headers.set('Cache-Control', noStore['Cache-Control'])
    return response
  }

  try {
    const completed = await composio.connectedAccounts.completeAuth({ userId: intent?.userId ?? session!.user.id, sessionUri })
    const userId = intent?.userId ?? session!.user.id
    // The flow cookie can drop; the connected account id Composio returned names the intent just as well.
    // Two same-toolkit links can overlap: the one that actually completed
    // names its own intent, not the cookie's latest link.
    const attempt = await composioConnectIntentByLink(pool, completed.connectedAccountId) ?? intent
    const replaceId = attempt ? attempt.replaceAccountId ?? undefined : flow?.link === completed.connectedAccountId ? flow.replace : undefined
    let reconnectComplete = false
    try {
      const [items, records] = await Promise.all([
        listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [userId], cursor })),
        listComposioAccountRecords(userId),
      ])
      // A reconnect retires the account it replaces only when this callback
      // completes the link that reconnect started; the old account's name and
      // default move to the new one. The email is read either way.
      reconnectComplete = await followUpComposioConnect({
        items,
        records,
        addedId: completed.connectedAccountId,
        replaceId,
      }, {
        readEmail: (toolkit, accountId) => readComposioAccountEmail(composio, userId, toolkit, accountId),
        saveEmail: (toolkit, accountId, email) => saveComposioAccountEmail(userId, toolkit, accountId, email),
        noteAttempt: (toolkit, accountId) => noteComposioEmailAttempt(userId, toolkit, accountId),
        rename: (accountId, alias) => renameComposioAccount(composio, accountId, alias),
        retire: accountId => retireComposioAccount(composio, userId, accountId, 'replace'),
        chooseDefault: (toolkit, accountId) => chooseComposioDefault(userId, toolkit, accountId),
        log: (step, error) => console.error('Composio connect follow-up failed', { step, error: error instanceof Error ? error.name : 'unknown' }),
      })
    } catch (error) {
      console.error('Composio connect follow-up failed', { step: 'list', error: error instanceof Error ? error.name : 'unknown' })
    }
    // Subscribe the new account's triggers and write the first briefing from what is there now.
    const timeZone = request.headers.get('x-vercel-ip-timezone')
    afterJob('after:suggestions-bootstrap', () => bootstrapSuggestions(userId, 'composio', timeZone))
    const response = back(reconnectComplete ? 'connected' : 'callback-failed', attempt)
    clearSessionCookie(request, response)
    response.headers.set('Cache-Control', noStore['Cache-Control'])
    return response
  } catch {
    const response = back('callback-failed', intent)
    clearSessionCookie(request, response)
    response.headers.set('Cache-Control', noStore['Cache-Control'])
    return response
  }
}

export const GET = withRequestLog('/api/integrations/composio/callback', handleGET)
