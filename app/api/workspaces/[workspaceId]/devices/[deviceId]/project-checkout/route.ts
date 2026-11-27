import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceMutationSession, governanceResponse } from '@/lib/governance/http'
import { setCheckoutBody, writeDeviceCheckout } from '@/lib/project-resources/device-checkouts'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ workspaceId: string; deviceId: string }> }

const POSTBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const params = await context.params
  const session = await governanceMutationSession(request, params.workspaceId)
  const body = setCheckoutBody.parse(await governanceJson(request))
  return writeDeviceCheckout(session, { ...params, projectId: body.projectId }, body.root)
}))

export const POST = defineRoute<'public', 'none', { workspaceId: string; deviceId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/devices/[deviceId]/project-checkout',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request, params }) => POSTBody(request, { params: Promise.resolve(params) }),
)
