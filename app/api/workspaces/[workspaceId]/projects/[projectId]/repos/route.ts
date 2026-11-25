import { ActionFailureError } from '@/lib/action-error'
import { freshSessionRoute } from '@/lib/fresh-session'
import { GovernanceError } from '@/lib/governance/errors'
import { governanceJson, governanceMutationSession, governanceResponse } from '@/lib/governance/http'
import { addProjectRepositoriesBody } from '@/lib/project-resources/contracts'
import { saveProjectResources } from '@/lib/project-resources/store'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ workspaceId: string; projectId: string }> }

const POSTBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const params = await context.params
  const session = await governanceMutationSession(request, params.workspaceId)
  const body = addProjectRepositoriesBody.parse(await governanceJson(request))
  try {
    return await saveProjectResources(session.user, { ...params, ...body })
  } catch (error) {
    if (error instanceof ActionFailureError && error.code === 'projectNotFound') throw new GovernanceError('not_found', error)
    if (error instanceof ActionFailureError && (error.code === 'projectArchived' || error.code === 'projectResourceConflict')) {
      return Response.json({ error: { code: error.code } }, { status: 409, headers: { 'cache-control': 'private, no-store' } })
    }
    throw error
  }
}))

export const POST = defineRoute<'public', 'none', { workspaceId: string; projectId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/projects/[projectId]/repos',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => POSTBody(request, { params: Promise.resolve(params) }),
)
