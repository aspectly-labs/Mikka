import { freshSessionRoute } from '@/lib/fresh-session'
import { z } from 'zod'
import { GovernanceError } from '@/lib/governance/errors'
import { hasPatAuthorizationHeader, isPatSession } from '@/lib/http-security'
import { defineRoute } from '@/lib/primitives/define-route'
import { AccountAuthenticationError, requireFreshAccountSession } from '@/lib/account/fresh-session'
import { cancelAccountDeletion, readAccountDeletionReceipt, requestAccountDeletion } from '@/lib/account/deletion-jobs'

const headers = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }
const receipt = z.string().uuid()
const requestBody = z.object({ email: z.string().trim().max(320), requestId: receipt }).strict()

const originDenied = () => Response.json({ error: 'originNotAllowed' }, { status: 403, headers })
const authRequired = () => Response.json({ error: 'authRequired' }, { status: 401, headers })
const deletionUnavailable = () => Response.json({ error: 'accountDeletionUnavailable' }, { status: 503, headers })

/** A caller keeps its private request UUID before POST so a lost response can be resumed. No ID appears in a URL. */
const POSTBody = defineRoute(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    disableRefresh: true,
    onOriginFailure: originDenied,
    onAuthFailure: authRequired,
    onAuthError: deletionUnavailable,
    desktop: true,
  },
  async ({ request, session: apiSession }) => {
    if (request.headers.get('origin') !== new URL(request.url).origin) return originDenied()
    if (hasPatAuthorizationHeader(request) || isPatSession(apiSession)) return Response.json({ error: 'authRequired' }, { status: 403, headers })
    let session
    try { session = await requireFreshAccountSession(request.headers) }
    catch (error) {
      if (error instanceof AccountAuthenticationError) return Response.json({ error: error.code }, { status: error.status, headers })
      return deletionUnavailable()
    }
    const input = requestBody.safeParse(await request.json().catch(() => null))
    if (!input.success || input.data.email.toLowerCase() !== session.user.email.toLowerCase()) return Response.json({ error: 'accountEmailMismatch' }, { status: 400, headers })
    try {
      const job = await requestAccountDeletion(session.user.id, session.user.email, input.data.requestId)
      if (!job.ok) return Response.json({ error: 'accountSoleAdmin', workspaces: job.soleAdminOf }, { status: 409, headers })
      return Response.json(await readAccountDeletionReceipt(job.id), { status: 202, headers })
    } catch (error) {
      if (error instanceof GovernanceError && error.detail === 'last_owner') return Response.json({ error: 'accountLastOrganizationOwner' }, { status: 409, headers })
      return deletionUnavailable()
    }
  },
)

/** Receipt capability remains usable when the account and its sessions have already been deleted. */
export const GET = defineRoute(
  { auth: 'public', origin: 'any', workspace: 'none', desktop: true },
  async ({ request }) => {
    const input = receipt.safeParse(request.headers.get('x-mikka-deletion-receipt'))
    if (!input.success) return Response.json({ error: 'accountDeletionUnavailable' }, { status: 404, headers })
    try { return Response.json(await readAccountDeletionReceipt(input.data), { headers }) }
    catch { return Response.json({ error: 'accountDeletionUnavailable' }, { status: 404, headers }) }
  },
)

const DELETEBody = defineRoute(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    onOriginFailure: originDenied,
    onAuthFailure: authRequired,
    desktop: true,
  },
  async ({ request, session }) => {
    if (request.headers.get('origin') !== new URL(request.url).origin) return originDenied()
    if (hasPatAuthorizationHeader(request) || isPatSession(session)) return Response.json({ error: 'authRequired' }, { status: 403, headers })
    if (!session.session) return authRequired()
    const input = receipt.safeParse(request.headers.get('x-mikka-deletion-receipt'))
    if (!input.success) return Response.json({ error: 'accountDeletionUnavailable' }, { status: 404, headers })
    try {
      const cancelled = await cancelAccountDeletion(session.user.id, input.data)
      return Response.json({ cancelled }, { status: cancelled ? 200 : 409, headers })
    } catch { return Response.json({ error: 'accountDeletionUnavailable' }, { status: 404, headers }) }
  },
)

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
export const DELETE = freshSessionRoute(DELETEBody)
