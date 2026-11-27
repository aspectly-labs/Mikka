import { RouteResponse } from '@/lib/server-runtime/server'
import type { ApiSession } from '@/lib/api-auth'
import { listPendingActions } from '@/lib/pending-action-store'
import { pendingActionsOutsideToken } from '@/lib/tokens/scope'
import { defineRoute } from '@/lib/primitives/define-route'

// A plain authenticated GET: push invalidates this read without queuing behind
// the app's own actions. Keep the array body for existing consumers.
async function handleGET(session: ApiSession) {
  const observedAt = new Date().toISOString()
  const listed = await listPendingActions(session.user.id)
  const outside = await pendingActionsOutsideToken(session.user, listed.map(item => item.id))
  return RouteResponse.json(listed.filter(item => !outside.has(item.id)), { headers: { 'Cache-Control': 'private, no-store', 'X-Mikka-Observed-At': observedAt, 'X-Mikka-Viewer': encodeURIComponent(session.user.id) } })
}

export const GET = defineRoute<'session', 'none'>(
  {
    route: '/api/pending-actions',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
  },
  async ({ session }) => handleGET(session),
)
