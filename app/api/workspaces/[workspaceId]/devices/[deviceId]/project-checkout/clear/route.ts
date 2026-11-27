import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceMutationSession, governanceResponse } from '@/lib/governance/http'
import { clearCheckoutBody, writeDeviceCheckout } from '@/lib/project-resources/device-checkouts'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ workspaceId: string; deviceId: string }> }

const POSTBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const params = await context.params
  const session = await governanceMutationSession(request, params.workspaceId)
  const body = clearCheckoutBody.parse(await governanceJson(request))
  await writeDeviceCheckout(session, { ...params, projectId: body.projectId }, null)
  return new Response(null, { status: 204, headers: { 'cache-control': 'private, no-store' } })
}))

export const POST = defineRoute<'public', 'none', { workspaceId: string; deviceId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/devices/[deviceId]/project-checkout/clear',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request, params }) => POSTBody(request, { params: Promise.resolve(params) }),
)
