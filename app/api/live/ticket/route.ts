import { RouteResponse } from '@/lib/server-runtime/server'
import { auth } from '@/lib/api-auth'
import { activeTaskWorkspaces } from '@/lib/task-workspace'
import { LIVE_ID } from '@/lib/live/events'
import { liveGatewayConfig } from '@/lib/live/scope'
import { workspaceLiveTicket } from '@/lib/enterprise/live-authority'
import { desktopBearerHeaders } from '@/lib/desktop-rpc/handler'
import { homeScopeProof } from '@/lib/live/home-scope-proof'
import { defineRoute } from '@/lib/primitives/define-route'
import { runtimeEnv } from '@/lib/env/server'

const headers = { 'cache-control': 'private, no-store' }

async function ticket(request: Request) {
  // A native session grants the same owner channel as its browser session. PATs
  // remain workspace-scoped and never grant this ambient owner capability.
  const bearerHeaders = request.headers.has('authorization') ? desktopBearerHeaders(request) : null
  if (request.headers.has('authorization') && !bearerHeaders) return RouteResponse.json({ error: 'authRequired' }, { status: 401, headers })
  // A new capability must not extend a revoked session through its cached cookie.
  const session = await auth.api.getSession({ headers: bearerHeaders ?? request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return RouteResponse.json({ error: 'authRequired' }, { status: 401, headers })
  const workspaceId = (new URL(request.url).searchParams.get('workspace') ?? '').toLowerCase()
  if (!LIVE_ID.test(workspaceId)) return RouteResponse.json({ error: 'workspaceAccessDenied' }, { status: 403, headers })
  const [workspace] = await activeTaskWorkspaces(session.user, workspaceId)
  if (!workspace) return RouteResponse.json({ error: 'workspaceAccessDenied' }, { status: 403, headers })
  const config = liveGatewayConfig(runtimeEnv())
  if (!config) return RouteResponse.json({ url: null, protocol: null, expiresAt: null }, { headers })
  const scope = { ownerId: session.user.id, workspaceId }
  const result = await workspaceLiveTicket(scope, session.session?.id ?? '', config)
  if (result.status === 'denied') return RouteResponse.json({ error: 'workspaceAccessDenied' }, { status: 403, headers })
  if (result.status === 'pending') return RouteResponse.json({ url: null, protocol: null, expiresAt: null }, { headers })
  const issued = result.ticket
  const homeScope = workspace.kind === 'personal' ? homeScopeProof(scope, issued.expiresAt, config.secret) : null
  return RouteResponse.json({ ...issued, ...(homeScope ? { homeScope } : {}) }, { headers })
}

export const GET = defineRoute<'public', 'none'>(
  {
    route: '/api/live/ticket',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request }) => ticket(request),
)
