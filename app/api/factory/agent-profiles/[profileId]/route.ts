import { agentProfileHandler } from '@/lib/factory/agent-profile-server'
import { defineRoute } from '@/lib/primitives/define-route'

const handle = ({ request, params, session }: { request: Request; params: { profileId: string }; session: Parameters<typeof agentProfileHandler>[2] }) => agentProfileHandler(request, params.profileId, session)

export const GET = defineRoute(
  {
    route: '/api/factory/agent-profiles/[profileId]',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  handle,
)
export const PATCH = defineRoute(
  {
    route: '/api/factory/agent-profiles/[profileId]',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  handle,
)
export const DELETE = defineRoute(
  {
    route: '/api/factory/agent-profiles/[profileId]',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  handle,
)
