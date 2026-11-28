import { defineRoute } from '@/lib/primitives/define-route'
import { RouteResponse } from '@/lib/server-runtime/server'

/** Read-only process liveness. It discloses no session, secrets or claimed SHA.
 * Database/business readiness still requires the independent verification and
 * real-user acceptance gates. Avoid querying the same pool held by monitor. */
export const GET = defineRoute(
  {
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  () =>
    RouteResponse.json(
      { status: 'ok', service: 'mikka' },
      {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      },
    ),
)
