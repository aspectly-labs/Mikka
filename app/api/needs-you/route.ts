import { RouteResponse } from '@/lib/server-runtime/server'
import type { ApiSession } from '@/lib/api-auth'
import { listNeedsYou } from '@/lib/needs-you'
import { defineRoute } from '@/lib/primitives/define-route'

const headers = { 'Cache-Control': 'private, no-store' }

/** One needs-you list across pending approvals and factory questions (#2935). */
async function handleGET(session: ApiSession) {
  return RouteResponse.json(await listNeedsYou(session.user), {
    headers: { ...headers, 'X-Mikka-Observed-At': new Date().toISOString(), 'X-Mikka-Viewer': session.user.id },
  })
}

export const GET = defineRoute<'session', 'none'>(
  {
    route: '/api/needs-you',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
  },
  async ({ session }) => handleGET(session),
)
