import { freshSessionRoute } from '@/lib/fresh-session'
import { withRequestLog } from '@/lib/request-log'
import { readDevicePolicy, writeDevicePolicy } from '@/lib/settings/device-policy'
import { readRequiredJsonBody, requireDeviceApiSession, wsGJsonResponse } from '@/lib/settings/device-policy-http'

type RouteContext = { params: Promise<{ deviceId: string }> }

export const GET = freshSessionRoute(withRequestLog('/api/devices/[deviceId]/policy', async (request: Request, context: RouteContext) =>
  wsGJsonResponse(async () => {
    const session = await requireDeviceApiSession(request, false)
    const { deviceId } = await context.params
    const workspaceId = new URL(request.url).searchParams.get('workspaceId')
    return readDevicePolicy(
      { userId: session.user.id, tokenWorkspaceId: session.tokenWorkspaceId },
      deviceId,
      workspaceId,
    )
  }),
))

export const PATCH = freshSessionRoute(withRequestLog('/api/devices/[deviceId]/policy', async (request: Request, context: RouteContext) =>
  wsGJsonResponse(async () => {
    const session = await requireDeviceApiSession(request, true)
    const { deviceId } = await context.params
    const workspaceId = new URL(request.url).searchParams.get('workspaceId')
    const body = await readRequiredJsonBody(request)
    return writeDevicePolicy(
      { userId: session.user.id, tokenWorkspaceId: session.tokenWorkspaceId },
      deviceId,
      body,
      workspaceId,
    )
  }),
))
