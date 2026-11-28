import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceMutationSession, governanceResponse, governanceSession } from '@/lib/governance/http'
import { manageServiceCredential } from '@/lib/governance/service-credentials'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ workspaceId: string; identityId: string }> }

const GETBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { workspaceId, identityId } = await context.params
  const session = await governanceSession(request, workspaceId)
  return manageServiceCredential(workspaceId, session.user, identityId)
}))

const POSTBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { workspaceId, identityId } = await context.params
  const session = await governanceMutationSession(request, workspaceId)
  return manageServiceCredential(workspaceId, session.user, identityId, await governanceJson(request))
}))

export const GET = defineRoute<'public', 'none', { workspaceId: string; identityId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/service-identities/[identityId]/credential',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)

export const POST = defineRoute<'public', 'none', { workspaceId: string; identityId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/service-identities/[identityId]/credential',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => POSTBody(request, { params: Promise.resolve(params) }),
)
