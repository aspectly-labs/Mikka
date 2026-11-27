import type { ApiSession } from '@/lib/api-auth'
import { agentProfileHandler } from '@/lib/factory/agent-profile-server'
import { defineRoute } from '@/lib/primitives/define-route'

const originMismatch = () => Response.json({ error: 'originMismatch' }, { status: 403, headers: { 'Cache-Control': 'private, no-store' } })
const handle = ({ request, params, session }: { request: Request; params: { profileId: string }; session: ApiSession }) =>
  agentProfileHandler(request, params.profileId, session)

export const GET = defineRoute(
  {
    route: '/api/factory/agent-profiles/[profileId]',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  handle,
)
export const PATCH = defineRoute(
  {
    route: '/api/factory/agent-profiles/[profileId]',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    onOriginFailure: originMismatch,
    desktop: true,
  },
  handle,
)
export const DELETE = defineRoute(
  {
    route: '/api/factory/agent-profiles/[profileId]',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    onOriginFailure: originMismatch,
    desktop: true,
  },
  handle,
)
