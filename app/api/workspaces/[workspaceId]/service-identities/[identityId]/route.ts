import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceMutationSession, governanceResponse, governanceSession } from '@/lib/governance/http'
import { getServiceIdentity, updateServiceIdentity } from '@/lib/governance/service-identities'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ workspaceId: string; identityId: string }> }

const GETBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { workspaceId, identityId } = await context.params
  const session = await governanceSession(request, workspaceId)
  return getServiceIdentity(workspaceId, session.user, identityId)
}))

const PATCHBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { workspaceId, identityId } = await context.params
  const session = await governanceMutationSession(request, workspaceId)
  return updateServiceIdentity(workspaceId, session.user, identityId, await governanceJson(request))
}))

export const GET = defineRoute<'public', 'none', { workspaceId: string; identityId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/service-identities/[identityId]',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)

export const PATCH = defineRoute<'public', 'none', { workspaceId: string; identityId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/service-identities/[identityId]',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => PATCHBody(request, { params: Promise.resolve(params) }),
)
