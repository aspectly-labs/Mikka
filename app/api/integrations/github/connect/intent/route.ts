import { pool } from '@/lib/db'
import { freshSessionRoute } from '@/lib/fresh-session'
import { createConnectIntent, loopbackStart, readConnectIntent } from '@/lib/github/connect-intent'
import { hasPatAuthorizationHeader, isPatSession, sameOriginMutationAllowed } from '@/lib/http-security'
import { defineRoute } from '@/lib/primitives/define-route'

const headers = { 'Cache-Control': 'private, no-store' }

/** The desktop app's Link GitHub: a one-time token naming the app's own account, for the browser it opens. */
const POSTBody = defineRoute(
  {
    route: '/api/integrations/github/connect/intent',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  async ({ request, session }) => {
    if (hasPatAuthorizationHeader(request) || isPatSession(session)) return Response.json({ error: 'sessionRequired' }, { status: 403, headers })
    if (!sameOriginMutationAllowed(request, { allowNativeWithoutOrigin: true })) return Response.json({ error: 'originNotAllowed' }, { status: 403, headers })
    // A desktop app with a loopback return sends where to return and S256 of its own verifier; an older one sends nothing.
    const body = await request.json().catch(() => null) as { loopback?: unknown } | null
    return Response.json(await createConnectIntent(pool, session.user.id, new Date(), loopbackStart(body?.loopback)), { headers })
  },
)

/** Where that link stands, for the app that started it or for a browser signed in as another account. */
export const GET = defineRoute(
  {
    route: '/api/integrations/github/connect/intent',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request, session }) => {
    if (hasPatAuthorizationHeader(request) || isPatSession(session)) return Response.json({ error: 'sessionRequired' }, { status: 403, headers })
    const token = new URL(request.url).searchParams.get('token') ?? ''
    return Response.json(await readConnectIntent(pool, token, session.user.id), { headers })
  },
)

// A credential flow: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
