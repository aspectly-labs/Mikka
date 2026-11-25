import { ActionFailureError } from '@/lib/action-error'
import { freshSessionRoute } from '@/lib/fresh-session'
import { GovernanceError } from '@/lib/governance/errors'
import { governanceResponse, governanceSession } from '@/lib/governance/http'
import { readCurrentProjectSetup } from '@/lib/project-resources/store'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ workspaceId: string; projectId: string }> }

const GETBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const params = await context.params
  const session = await governanceSession(request, params.workspaceId)
  try {
    return await readCurrentProjectSetup(session.user, params)
  } catch (error) {
    if (error instanceof ActionFailureError && error.code === 'projectNotFound') throw new GovernanceError('not_found', error)
    throw error
  }
}))

export const GET = defineRoute<'public', 'none', { workspaceId: string; projectId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/projects/[projectId]/setup',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)
