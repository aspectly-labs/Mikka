import { RouteResponse } from '@/lib/server-runtime/server'
import type { ApiSession } from '@/lib/api-auth'
import type { PendingActionView } from '@/lib/pending-action-view'
import { defineRoute } from '@/lib/primitives/define-route'

// Nothing waits for approval (ADR 2026-11-27-1615): the list is always empty.
// Kept for one release with its array body and owner/read-time headers, because
// the official UI still reads it; remove with the hosted follow-up.
async function handleGET(session: ApiSession) {
  const observedAt = new Date().toISOString()
  const listed: PendingActionView[] = []
  return RouteResponse.json(listed, { headers: { 'Cache-Control': 'private, no-store', 'X-Mikka-Observed-At': observedAt, 'X-Mikka-Viewer': encodeURIComponent(session.user.id) } })
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
