import { pool } from '@/lib/db'
import { freshSessionRoute } from '@/lib/fresh-session'
import { confirmLoopbackIntent } from '@/lib/github/connect-intent'
import { saveSealedGitHubConnection } from '@/lib/github/connection'
import { hasPatAuthorizationHeader, isPatSession, sameOriginMutationAllowed } from '@/lib/http-security'
import { defineRoute } from '@/lib/primitives/define-route'

const headers = { 'Cache-Control': 'private, no-store' }

/**
 * The desktop app's loopback got GitHub's return, so it was this computer: it
 * sends the verifier only it holds, and the waiting answer becomes this
 * account's connection.
 */
const POSTBody = defineRoute(
  {
    route: '/api/integrations/github/connect/intent/confirm',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  async ({ request, session }) => {
    if (hasPatAuthorizationHeader(request) || isPatSession(session)) return Response.json({ error: 'sessionRequired' }, { status: 403, headers })
    if (!sameOriginMutationAllowed(request, { allowNativeWithoutOrigin: true })) return Response.json({ error: 'originNotAllowed' }, { status: 403, headers })
    const body = await request.json().catch(() => null) as { token?: unknown; verifier?: unknown } | null
    const linked = typeof body?.token === 'string' ? await confirmLoopbackIntent(pool, body.token, body.verifier, session.user.id, { save: saveSealedGitHubConnection }) : null
    if (!linked) return Response.json({ error: 'linkUnavailable' }, { status: 409, headers })
    return Response.json(linked, { headers })
  },
)

// A credential write: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
