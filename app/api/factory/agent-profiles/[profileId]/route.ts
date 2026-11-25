import { agentProfileHandler } from '@/lib/factory/agent-profile-server'
import { defineRoute } from '@/lib/primitives/define-route'

const handle = ({ request, params }: { request: Request; params: { profileId: string } }) => agentProfileHandler(request, params.profileId)

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
