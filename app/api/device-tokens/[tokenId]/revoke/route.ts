import { freshSessionRoute } from '@/lib/fresh-session'
import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { revokeDeviceCredential } from '@/lib/device-revocation'
import { hasPatAuthorizationHeader, isPatSession } from '@/lib/http-security'
import { defineRoute } from '@/lib/primitives/define-route'


/** Only the owner's normal application session can revoke a credential. */
const POSTBody = defineRoute<'session', 'none', { tokenId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    onOriginFailure: () => RouteResponse.json({ error: 'originRejected' }, { status: 403 }),
    desktop: true,
  },
  async ({ request, params, session }) => {
    if (request.headers.get('origin') !== new URL(request.url).origin) return RouteResponse.json({ error: 'originRejected' }, { status: 403 })
    if (hasPatAuthorizationHeader(request) || isPatSession(session)) return RouteResponse.json({ error: 'authRequired' }, { status: 401 })
    const { tokenId } = params
    if (!z.uuid().safeParse(tokenId).success) return RouteResponse.json({ error: 'unknownCredential' }, { status: 404 })
    const receipt = await revokeDeviceCredential(pool, session.user.id, tokenId)
    return receipt ? RouteResponse.json(receipt, { headers: { 'Cache-Control': 'private, no-store' } })
      : RouteResponse.json({ error: 'unknownCredential' }, { status: 404 })
  },
)

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
