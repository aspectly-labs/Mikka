import { defineRoute } from '@/lib/primitives/define-route'


/** Global availability only. No session, user, token or database reads. */
async function unguardedGET() {
  return Response.json({ enabled: false, state: 'disabled' }, { headers: { 'cache-control': 'no-store' } })
}
export const GET = defineRoute(
  {
    route: '/api/integrations/linear/status',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  () => unguardedGET(),
)
