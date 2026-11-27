import { agentProfileHandler } from '@/lib/factory/agent-profile-server'
import { defineRoute } from '@/lib/primitives/define-route'

const originMismatch = () => Response.json({ error: 'originMismatch' }, { status: 403, headers: { 'Cache-Control': 'private, no-store' } })

export const GET = defineRoute(
  {
    route: '/api/factory/agent-profiles',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request, session }) => agentProfileHandler(request, undefined, session),
)
export const POST = defineRoute(
  {
    route: '/api/factory/agent-profiles',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    onOriginFailure: originMismatch,
    desktop: true,
  },
  ({ request, session }) => agentProfileHandler(request, undefined, session),
)
