import { NextResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { auth, authBaseURL } from '@/lib/auth'
import { BASE_PATH } from '@/lib/base-path'
import { pool } from '@/lib/db'
import { getComposio } from '@/lib/composio'
import { isComposioCallbackVerifierConfigured } from '@/lib/composio-config'
import { isToolkitSlug, TOOLKIT_SLUG } from '@/lib/composio-accounts'
import { composioLoopback, createComposioConnectIntent } from '@/lib/composio-connect-intent'
import { listComposioPages } from '@/lib/composio-pagination'
import { assertCatalogToolkit, composioToolkitLister } from '@/lib/plugins/catalog'
import { PluginError } from '@/lib/plugins/contracts'
import { noteLogUser, withRequestLog } from '@/lib/request-log'

/**
 * A Composio link from the desktop app: a one-time token naming the app's own
 * account and its loopback return (RFC 8252 §7.3), for the browser it opens.
 * The browser then needs no session of its own: the link is this account's
 * whatever it is signed in as.
 */
const intentSchema = z.union([
  z.object({ toolkit: z.string().regex(TOOLKIT_SLUG), loopback: z.unknown() }).strict(),
  z.object({ accountId: z.string().trim().min(1).max(255), loopback: z.unknown() }).strict(),
])

function sameOrigin(request: Request) {
  return request.headers.get('origin') === new URL(request.url).origin
}

async function handlePOST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  noteLogUser(session?.user?.id)
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  if (!sameOrigin(request)) return NextResponse.json({ error: 'originNotAllowed' }, { status: 403 })
  const parsed = intentSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalidIntegration' }, { status: 400 })
  const loopback = composioLoopback(parsed.data.loopback)
  if (!loopback) return NextResponse.json({ error: 'invalidIntegration' }, { status: 400 })
  const composio = getComposio()
  if (!composio) return NextResponse.json({ error: 'composioNotConfigured' }, { status: 503 })
  if (!isComposioCallbackVerifierConfigured(authBaseURL, BASE_PATH)) return NextResponse.json({ error: 'callbackVerifierNotConfigured' }, { status: 503 })
  try {
    // Reconnect names the account it replaces, verified as the person's own.
    const data = parsed.data
    const replacing = 'accountId' in data
      ? (await listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [session.user.id], cursor }))).find(item => item.id === data.accountId && isToolkitSlug(item.toolkit.slug))
      : undefined
    if ('accountId' in data && !replacing) return NextResponse.json({ error: 'integrationNotFound' }, { status: 404 })
    const toolkit = 'toolkit' in data ? data.toolkit : replacing!.toolkit.slug
    if ('toolkit' in parsed.data) await assertCatalogToolkit(composioToolkitLister(composio), toolkit)
    const intent = await createComposioConnectIntent(pool, {
      userId: session.user.id, toolkit, replaceAccountId: replacing?.id ?? null, ...loopback,
    })
    return NextResponse.json(intent, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof PluginError) return NextResponse.json({ error: error.code }, { status: error.status })
    return NextResponse.json({ error: 'integrationStartFailed' }, { status: 502 })
  }
}

export const POST = withRequestLog('/api/integrations/composio/connect/intent', handlePOST)
