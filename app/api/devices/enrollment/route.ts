import { freshSessionRoute } from '@/lib/fresh-session'
import { RouteResponse } from '@/lib/server-runtime/server'
import { hasPatAuthorizationHeader, isPatSession, sameOriginMutationAllowed } from '@/lib/http-security'
import { defineRoute } from '@/lib/primitives/define-route'
import { mintDeviceEnrollment } from '@/lib/device-enrollment'
import { pool } from '@/lib/db'

/** The desktop main process checks its daemon against this session's devices.
 * Account ownership is personal; changing workspace does not change this set. */
export const GET = defineRoute(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  async ({ request, session }) => {
    if (hasPatAuthorizationHeader(request) || isPatSession(session)) return new Response(null, { status: 403 })
    const views = new URL(request.url).searchParams.getAll('view')
    if (views.length > 1 || views.some(view => view !== 'owner')) return new Response(null, { status: 400 })
    // Starting local setup only needs its fresh account identity. Device
    // ownership is read separately when main verifies the resulting daemon.
    if (views[0] === 'owner') return RouteResponse.json({ ownerId: session.user.id }, { headers: { 'Cache-Control': 'private, no-store' } })
    const { rows } = await pool.query<{ id: string }>('SELECT id::text AS id FROM devices WHERE "ownerId"=$1 AND kind=\'local\' AND "removedAt" IS NULL', [session.user.id])
    return RouteResponse.json({ ownerId: session.user.id, deviceIds: rows.map(row => row.id) }, { headers: { 'Cache-Control': 'private, no-store' } })
  },
)

const POSTBody = defineRoute(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  async ({ request, session }) => {
    // This is a browser session endpoint, never a device-token or workspace-PAT endpoint.
    if (hasPatAuthorizationHeader(request) || isPatSession(session)) return new Response(null, { status: 403 })
    if (!sameOriginMutationAllowed(request)) return new Response(null, { status: 403 })
    return RouteResponse.json({ token: await mintDeviceEnrollment(session.user.id) }, { headers: { 'Cache-Control': 'no-store' } })
  },
)

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
