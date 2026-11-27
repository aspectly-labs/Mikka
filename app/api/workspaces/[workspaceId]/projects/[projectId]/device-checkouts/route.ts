import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceResponse, governanceSession } from '@/lib/governance/http'
import { listDeviceCheckouts } from '@/lib/project-resources/device-checkouts'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ workspaceId: string; projectId: string }> }

const GETBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const params = await context.params
  const session = await governanceSession(request, params.workspaceId)
  return listDeviceCheckouts(session, params)
}))

export const GET = defineRoute<'public', 'none', { workspaceId: string; projectId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/projects/[projectId]/device-checkouts',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)
