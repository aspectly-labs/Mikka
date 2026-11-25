import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { authBaseURL } from '@/lib/auth'
import { BASE_PATH } from '@/lib/base-path'
import { getComposio, readComposioAccountEmail, renameComposioAccount, retireComposioAccount } from '@/lib/composio'
import { chooseComposioDefault, listComposioAccountRecords, noteComposioEmailAttempt, saveComposioAccountEmail } from '@/lib/composio-account-store'
import { backfillComposioEmails } from '@/lib/composio-connect'
import { accountUpdateSchema, isDuplicateAliasError, isToolkitSlug, TOOLKIT_SLUG, safeReturnPath, toConnectedAccountView, withAccountRecords } from '@/lib/composio-accounts'
import { isComposioCallbackVerifierConfigured } from '@/lib/composio-config'
import { COMPOSIO_FLOW_COOKIE, composioFlowCookieOptions, encodeComposioFlow } from '@/lib/composio-flow'
import { listComposioPages } from '@/lib/composio-pagination'
import { assertCatalogToolkit, composioToolkitLister, composioToolkitRetriever } from '@/lib/plugins/catalog'
import { PluginError } from '@/lib/plugins/contracts'
import { isPatSession, sameOriginMutationAllowed } from '@/lib/http-security'
import { defineRoute } from '@/lib/primitives/define-route'

const accountIdSchema = z.string().trim().min(1).max(255)
const returnToSchema = z.string().max(512).optional()
// Connect a new account for a toolkit, or reconnect one the person has;
// `returnTo` is where the callback sends them back (validated again there).
const connectSchema = z.union([
  z.object({ toolkit: z.string().regex(TOOLKIT_SLUG), returnTo: returnToSchema }).strict(),
  z.object({ accountId: accountIdSchema, returnTo: returnToSchema }).strict(),
])
/** Each provider lookup while loading the list; the page waits for these. */
const EMAIL_BACKFILL_TIMEOUT_MS = 3_000
const disconnectSchema = z.object({ accountId: accountIdSchema })

function sameOrigin(request: Request) {
  return sameOriginMutationAllowed(request)
}

type ComposioClient = NonNullable<ReturnType<typeof getComposio>>

/** The person's own account with this id, or undefined. */
async function findOwnAccount(composio: ComposioClient, userId: string, accountId: string) {
  const items = await listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [userId], cursor }))
  return items.find(item => item.id === accountId && isToolkitSlug(item.toolkit.slug))
}

export const GET = defineRoute(
  {
    route: '/api/integrations/composio',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
  },
  async ({ session }) => {
    if (isPatSession(session)) return RouteResponse.json({ error: 'sessionRequired' }, { status: 403 })
    const composio = getComposio()
    const callbackVerifierConfigured = isComposioCallbackVerifierConfigured(authBaseURL, BASE_PATH)
    const webhookConfigured = Boolean(process.env.COMPOSIO_API_KEY && process.env.COMPOSIO_WEBHOOK_SECRET)
    if (!composio) {
      return RouteResponse.json({ configured: false, callbackVerifierConfigured, webhookConfigured, accounts: [] }, { headers: { 'Cache-Control': 'private, no-store' } })
    }
    try {
      const [items, records] = await Promise.all([
        listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [session.user.id], cursor })),
        listComposioAccountRecords(session.user.id),
      ])
      const userId = session.user.id
      // Accounts connected before Mikka kept emails: a few per load, each asked once.
      const filled = await backfillComposioEmails({ items, records }, {
        readEmail: (toolkit, accountId) => readComposioAccountEmail(composio, userId, toolkit, accountId, EMAIL_BACKFILL_TIMEOUT_MS),
        saveEmail: (toolkit, accountId, email) => saveComposioAccountEmail(userId, toolkit, accountId, email),
        noteAttempt: (toolkit, accountId) => noteComposioEmailAttempt(userId, toolkit, accountId),
        rename: (accountId, alias) => renameComposioAccount(composio, accountId, alias),
      })
      const accounts = withAccountRecords(items.flatMap(account => toConnectedAccountView(account) ?? []), filled)
      return RouteResponse.json({ configured: true, callbackVerifierConfigured, webhookConfigured, accounts }, { headers: { 'Cache-Control': 'private, no-store' } })
    } catch {
      return RouteResponse.json({ error: 'integrationsUnavailable' }, { status: 502 })
    }
  },
)

export const POST = defineRoute(
  {
    route: '/api/integrations/composio',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
  },
  async ({ request, session }) => {
    if (isPatSession(session)) return RouteResponse.json({ error: 'sessionRequired' }, { status: 403 })
    if (!sameOrigin(request)) return RouteResponse.json({ error: 'originNotAllowed' }, { status: 403 })
    const parsed = connectSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return RouteResponse.json({ error: 'invalidIntegration' }, { status: 400 })
    const composio = getComposio()
    if (!composio) return RouteResponse.json({ error: 'composioNotConfigured' }, { status: 503 })
    if (!isComposioCallbackVerifierConfigured(authBaseURL, BASE_PATH)) return RouteResponse.json({ error: 'callbackVerifierNotConfigured' }, { status: 503 })
    try {
      // Reconnect starts a fresh link for the same toolkit (Composio deprecated
      // refreshing an account in place); the callback then retires the old one.
      const replacing = 'accountId' in parsed.data ? await findOwnAccount(composio, session.user.id, parsed.data.accountId) : undefined
      if ('accountId' in parsed.data && !replacing) return RouteResponse.json({ error: 'integrationNotFound' }, { status: 404 })
      const toolkit = 'toolkit' in parsed.data ? parsed.data.toolkit : replacing!.toolkit.slug
      // A new connection must be a store toolkit with Composio-managed auth.
      // Reconnecting an existing account remains possible during catalog outages.
      if ('toolkit' in parsed.data) await assertCatalogToolkit(composioToolkitLister(composio), toolkit, 'managed', composioToolkitRetriever(composio))
      const composioSession = await composio.create(session.user.id)
      const connection = await composioSession.authorize(toolkit)
      if (!connection.redirectUrl) return RouteResponse.json({ error: 'integrationStartFailed' }, { status: 502 })
      const response = RouteResponse.json({ redirectUrl: connection.redirectUrl }, { headers: { 'Cache-Control': 'no-store' } })
      // Bound to this link: the callback acts on `replace` only when it completes `link`.
      const returnTo = safeReturnPath(parsed.data.returnTo) ?? undefined
      response.cookies.set(COMPOSIO_FLOW_COOKIE, encodeComposioFlow({ link: connection.id, replace: replacing?.id, returnTo }), composioFlowCookieOptions(request.url, 600))
      return response
    } catch (error) {
      if (error instanceof PluginError) return RouteResponse.json({ error: error.code }, { status: error.status })
      return RouteResponse.json({ error: 'integrationStartFailed' }, { status: 502 })
    }
  },
)

export const DELETE = defineRoute(
  {
    route: '/api/integrations/composio',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
  },
  async ({ request, session }) => {
    if (isPatSession(session)) return RouteResponse.json({ error: 'sessionRequired' }, { status: 403 })
    if (!sameOrigin(request)) return RouteResponse.json({ error: 'originNotAllowed' }, { status: 403 })
    const parsed = disconnectSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return RouteResponse.json({ error: 'invalidIntegration' }, { status: 400 })
    const composio = getComposio()
    if (!composio) return RouteResponse.json({ error: 'composioNotConfigured' }, { status: 503 })
    try {
      const account = await findOwnAccount(composio, session.user.id, parsed.data.accountId)
      if (!account) return RouteResponse.json({ error: 'integrationNotFound' }, { status: 404 })
      await retireComposioAccount(composio, session.user.id, account.id, 'disconnect')
      return new Response(null, { status: 204 })
    } catch {
      return RouteResponse.json({ error: 'integrationDisconnectFailed' }, { status: 502 })
    }
  },
)

/** Turns an account on or off (Composio's `isDisabled`), renames it, or makes it the toolkit's default. */
export const PATCH = defineRoute(
  {
    route: '/api/integrations/composio',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
  },
  async ({ request, session }) => {
    if (isPatSession(session)) return RouteResponse.json({ error: 'sessionRequired' }, { status: 403 })
    if (!sameOrigin(request)) return RouteResponse.json({ error: 'originNotAllowed' }, { status: 403 })
    const parsed = accountUpdateSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return RouteResponse.json({ error: 'invalidIntegration' }, { status: 400 })
    const composio = getComposio()
    if (!composio) return RouteResponse.json({ error: 'composioNotConfigured' }, { status: 503 })
    try {
      const account = await findOwnAccount(composio, session.user.id, parsed.data.accountId)
      if (!account) return RouteResponse.json({ error: 'integrationNotFound' }, { status: 404 })
      if ('enabled' in parsed.data) {
        if (parsed.data.enabled) await composio.connectedAccounts.enable(account.id)
        else await composio.connectedAccounts.disable(account.id)
      } else if ('default' in parsed.data) {
        await chooseComposioDefault(session.user.id, account.toolkit.slug, account.id)
      } else {
        try {
          await renameComposioAccount(composio, account.id, parsed.data.alias)
        } catch (error) {
          if (isDuplicateAliasError(error)) return RouteResponse.json({ error: 'aliasTaken' }, { status: 409 })
          throw error
        }
      }
      return new Response(null, { status: 204 })
    } catch {
      return RouteResponse.json({ error: 'integrationUpdateFailed' }, { status: 502 })
    }
  },
)
