import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationAccountSession } from '@/lib/enterprise/http'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { GovernanceError } from '@/lib/governance/errors'
import { changePersonalProject } from '@/lib/project-input'
import { personalProjectSelectionFor } from '@/lib/resource-access/personal-project-selection'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ workspaceId: string }> }

const GETBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const session = await organizationAccountSession(request)
  const reader = request.headers.get('x-mikka-reader-id')
  if (reader !== null && reader !== session.user.id) throw new GovernanceError('access_denied')
  return personalProjectSelectionFor(session.user, (await context.params).workspaceId)
}))

const PUTBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const session = await organizationAccountSession(request)
  const change = changePersonalProject.parse(await governanceJson(request))
  return personalProjectSelectionFor(session.user, (await context.params).workspaceId, change)
}))

export const GET = defineRoute<'public', 'none', { workspaceId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/personal-default-project',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)

export const PUT = defineRoute<'public', 'none', { workspaceId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/personal-default-project',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => PUTBody(request, { params: Promise.resolve(params) }),
)
