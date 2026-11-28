import { ActionFailureError } from '@/lib/action-error'
import { freshSessionRoute } from '@/lib/fresh-session'
import { GovernanceError } from '@/lib/governance/errors'
import { governanceResponse, governanceSession } from '@/lib/governance/http'
import { readOrganizationProjectEnvironmentVariable } from '@/lib/project-resources/store'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ organizationId: string; projectId: string; name: string }> }

const GETBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const params = await context.params
  const session = await governanceSession(request)
  try {
    return await readOrganizationProjectEnvironmentVariable(session.user, params)
  } catch (error) {
    if (error instanceof ActionFailureError && ['projectNotFound', 'workspaceAccessDenied'].includes(error.code)) throw new GovernanceError('not_found', error)
    throw error
  }
}))

export const GET = defineRoute<'public', 'none', { organizationId: string; projectId: string; name: string }>(
  {
    route: '/api/organizations/[organizationId]/projects/[projectId]/environment-variables/[name]/value',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)
