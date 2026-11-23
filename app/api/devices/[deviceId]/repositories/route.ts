import { freshSessionRoute } from '@/lib/fresh-session'
import { withRequestLog } from '@/lib/request-log'
import {
  deleteDeviceRepository,
  listDeviceRepositories,
  patchDeviceRepository,
  upsertDeviceRepository,
} from '@/lib/settings/device-policy'
import {
  readOptionalJsonBody,
  readRequiredJsonBody,
  requireDeviceApiSession,
  wsGJsonResponse,
} from '@/lib/settings/device-policy-http'

type RouteContext = { params: Promise<{ deviceId: string }> }

export const GET = freshSessionRoute(withRequestLog('/api/devices/[deviceId]/repositories', async (request: Request, context: RouteContext) =>
  wsGJsonResponse(async () => {
    const session = await requireDeviceApiSession(request, false)
    const { deviceId } = await context.params
    return listDeviceRepositories({ userId: session.user.id, tokenWorkspaceId: session.tokenWorkspaceId }, deviceId)
  }),
))

export const PUT = freshSessionRoute(withRequestLog('/api/devices/[deviceId]/repositories', async (request: Request, context: RouteContext) =>
  wsGJsonResponse(async () => {
    const session = await requireDeviceApiSession(request, true)
    const { deviceId } = await context.params
    const body = await readRequiredJsonBody(request)
    return upsertDeviceRepository({ userId: session.user.id, tokenWorkspaceId: session.tokenWorkspaceId }, deviceId, body)
  }),
))

export const PATCH = freshSessionRoute(withRequestLog('/api/devices/[deviceId]/repositories', async (request: Request, context: RouteContext) =>
  wsGJsonResponse(async () => {
    const session = await requireDeviceApiSession(request, true)
    const { deviceId } = await context.params
    const body = await readRequiredJsonBody(request)
    return patchDeviceRepository({ userId: session.user.id, tokenWorkspaceId: session.tokenWorkspaceId }, deviceId, body)
  }),
))

export const DELETE = freshSessionRoute(withRequestLog('/api/devices/[deviceId]/repositories', async (request: Request, context: RouteContext) =>
  wsGJsonResponse(async () => {
    const session = await requireDeviceApiSession(request, true)
    const { deviceId } = await context.params
    const params = new URL(request.url).searchParams
    const queryId = params.get('id') ?? undefined
    const queryRepoKey = params.get('repoKey') ?? undefined
    const body = await readOptionalJsonBody(request)
    const input = body && typeof body === 'object' ? body : {
      ...(queryId ? { id: queryId } : {}),
      ...(queryRepoKey ? { repoKey: queryRepoKey } : {}),
    }
    return deleteDeviceRepository({ userId: session.user.id, tokenWorkspaceId: session.tokenWorkspaceId }, deviceId, input)
  }),
))
