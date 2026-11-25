import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceMutationSession, governanceResponse, governanceSession } from '@/lib/governance/http'
import { serviceProjectAccess, serviceProjectChoices } from '@/lib/governance/service-project-access'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ workspaceId: string; identityId: string }> }

const GETBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { workspaceId, identityId } = await context.params
  const session = await governanceSession(request, workspaceId)
  const query = new URL(request.url).searchParams
  if (query.get('view') === 'choices') return serviceProjectChoices(workspaceId, session.user, identityId, query.get('after'))
  return serviceProjectAccess(workspaceId, session.user, identityId)
}))

const PUTBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { workspaceId, identityId } = await context.params
  const session = await governanceMutationSession(request, workspaceId)
  return serviceProjectAccess(workspaceId, session.user, identityId, await governanceJson(request))
}))

export const GET = defineRoute<'public', 'none', { workspaceId: string; identityId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/service-identities/[identityId]/projects',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)

export const PUT = defineRoute<'public', 'none', { workspaceId: string; identityId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/service-identities/[identityId]/projects',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => PUTBody(request, { params: Promise.resolve(params) }),
)
