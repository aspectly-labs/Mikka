import { RouteResponse } from '@/lib/server-runtime/server'
import { auth } from '@/lib/auth'
import { withRequestLog } from '@/lib/request-log'
import { officialWebOriginAllowed } from '@/lib/web-connection/policy'
import { webAuthHeaders, webBearer } from '@/lib/web-connection/auth-server'

async function handlePOST(request: Request) {
  if (!officialWebOriginAllowed(request.headers.get('origin'))) return RouteResponse.json({ error: 'web_auth_forbidden' }, { status: 403, headers: webAuthHeaders })
  const token = webBearer(request)
  if (!token) return RouteResponse.json({ error: 'web_auth_session_expired' }, { status: 401, headers: webAuthHeaders })
  const { internalAdapter } = await auth.$context
  const session = await internalAdapter.findSession(token)
  if (!session || session.session.expiresAt.getTime() <= Date.now()) return RouteResponse.json({ error: 'web_auth_session_expired' }, { status: 401, headers: webAuthHeaders })
  await internalAdapter.deleteSession(token)
  return new RouteResponse(null, { status: 204, headers: webAuthHeaders })
}
export const POST = withRequestLog('/api/web/revoke', handlePOST)
