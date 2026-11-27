import { linearSyncState } from '@/lib/linear-sync/flags'
import { defineRoute } from '@/lib/primitives/define-route'


/** Global availability only. No session, user, token or database reads. */
async function unguardedGET() {
  const state = await linearSyncState()
  return Response.json({ enabled: state === 'enabled', state }, { headers: { 'cache-control': 'no-store' } })
}
export const GET = defineRoute(
  {
    route: '/api/integrations/linear/status',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    desktop: true,
  },
  () => unguardedGET(),
)
