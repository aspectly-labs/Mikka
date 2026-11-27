import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceMutationSession, governanceSession } from '@/lib/governance/http'
import { taskLabelsResponse } from '@/lib/task-labels/http'
import { createWorkspaceTaskLabel, readWorkspaceTaskLabels } from '@/lib/task-labels/store'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ workspaceId: string }> }
const GETBody = freshSessionRoute((request: Request, context: Context) => taskLabelsResponse(async () => {
  const { workspaceId } = await context.params
  return readWorkspaceTaskLabels((await governanceSession(request, workspaceId)).user, workspaceId)
}))
const POSTBody = freshSessionRoute((request: Request, context: Context) => taskLabelsResponse(async () => {
  const { workspaceId } = await context.params
  const session = await governanceMutationSession(request, workspaceId)
  return createWorkspaceTaskLabel(session.user, workspaceId, await governanceJson(request))
}))

export const GET = defineRoute<'public', 'none', { workspaceId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/task-labels',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)

export const POST = defineRoute<'public', 'none', { workspaceId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/task-labels',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => POSTBody(request, { params: Promise.resolve(params) }),
)
