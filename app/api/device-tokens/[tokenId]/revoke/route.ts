import { freshSessionRoute } from '@/lib/fresh-session'
import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { revokeDeviceCredential } from '@/lib/device-revocation'


/** Only the owner's normal application session can revoke a credential. */
async function POSTBody(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return RouteResponse.json({ error: 'originRejected' }, { status: 403 })
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return RouteResponse.json({ error: 'authRequired' }, { status: 401 })
  const { tokenId } = await params
  if (!z.uuid().safeParse(tokenId).success) return RouteResponse.json({ error: 'unknownCredential' }, { status: 404 })
  const receipt = await revokeDeviceCredential(pool, session.user.id, tokenId)
  return receipt ? RouteResponse.json(receipt, { headers: { 'Cache-Control': 'private, no-store' } })
    : RouteResponse.json({ error: 'unknownCredential' }, { status: 404 })
}

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
