import { agentProfileHandler } from '@/lib/factory/agent-profile-server'
import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute(
  {
    route: '/api/factory/agent-profiles',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request }) => agentProfileHandler(request),
)
export const POST = defineRoute(
  {
    route: '/api/factory/agent-profiles',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request }) => agentProfileHandler(request),
)
