import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceMutationSession } from '@/lib/governance/http'
import { taskLabelsResponse } from '@/lib/task-labels/http'
import { mergeWorkspaceTaskLabels } from '@/lib/task-labels/store'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ workspaceId: string; labelId: string }> }
const POSTBody = freshSessionRoute((request: Request, context: Context) => taskLabelsResponse(async () => {
  const { workspaceId, labelId } = await context.params
  const session = await governanceMutationSession(request, workspaceId)
  return mergeWorkspaceTaskLabels(session.user, workspaceId, labelId, await governanceJson(request))
}))

export const POST = defineRoute<'public', 'none', { workspaceId: string; labelId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/task-labels/[labelId]/merge',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => POSTBody(request, { params: Promise.resolve(params) }),
)
