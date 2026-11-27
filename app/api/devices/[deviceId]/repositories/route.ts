import { freshSessionRoute } from '@/lib/fresh-session'
import { defineRoute } from '@/lib/primitives/define-route'
import {
  deleteDeviceRepository,
  listDeviceRepositories,
  patchDeviceRepository,
  upsertDeviceRepository,
} from '@/lib/settings/device-policy'
import {
  readOptionalJsonBody,
  readRequiredJsonBody,
  wsGJsonResponse,
} from '@/lib/settings/device-policy-http'
import { WorkspaceError } from '@/lib/workspace-access'

function assertCookieMutationOrigin(request: Request, tokenId: string | undefined) {
  if (!tokenId && request.headers.has('cookie') && !request.headers.has('origin')) {
    throw new WorkspaceError('workspaceAccessDenied')
  }
}

export const GET = freshSessionRoute(defineRoute<'session', 'none', { deviceId: string }>(
  { auth: 'session', origin: 'any', workspace: 'none', freshSession: true, route: '/api/devices/[deviceId]/repositories' },
  async ({ params, session }) =>
    wsGJsonResponse(async () =>
      listDeviceRepositories({ userId: session.user.id, tokenWorkspaceId: session.tokenWorkspaceId }, params.deviceId),
    ),
))

const deviceOriginDenied = () => Response.json(
  { error: 'workspaceAccessDenied' },
  { status: 403, headers: { 'cache-control': 'private, no-store' } },
)

export const PUT = freshSessionRoute(defineRoute<'session', 'none', { deviceId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    route: '/api/devices/[deviceId]/repositories',
    onOriginFailure: deviceOriginDenied,
  },
  async ({ request, params, session }) =>
    wsGJsonResponse(async () => {
      assertCookieMutationOrigin(request, session.tokenId)
      const body = await readRequiredJsonBody(request)
      return upsertDeviceRepository({ userId: session.user.id, tokenWorkspaceId: session.tokenWorkspaceId }, params.deviceId, body)
    }),
))

export const PATCH = freshSessionRoute(defineRoute<'session', 'none', { deviceId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    route: '/api/devices/[deviceId]/repositories',
    onOriginFailure: deviceOriginDenied,
  },
  async ({ request, params, session }) =>
    wsGJsonResponse(async () => {
      assertCookieMutationOrigin(request, session.tokenId)
      const body = await readRequiredJsonBody(request)
      return patchDeviceRepository({ userId: session.user.id, tokenWorkspaceId: session.tokenWorkspaceId }, params.deviceId, body)
    }),
))

export const DELETE = freshSessionRoute(defineRoute<'session', 'none', { deviceId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    route: '/api/devices/[deviceId]/repositories',
    onOriginFailure: deviceOriginDenied,
  },
  async ({ request, params, session }) =>
    wsGJsonResponse(async () => {
      assertCookieMutationOrigin(request, session.tokenId)
      const searchParams = new URL(request.url).searchParams
      const queryId = searchParams.get('id') ?? undefined
      const queryRepoKey = searchParams.get('repoKey') ?? undefined
      const body = await readOptionalJsonBody(request)
      const input = body && typeof body === 'object' ? body : {
        ...(queryId ? { id: queryId } : {}),
        ...(queryRepoKey ? { repoKey: queryRepoKey } : {}),
      }
      return deleteDeviceRepository({ userId: session.user.id, tokenWorkspaceId: session.tokenWorkspaceId }, params.deviceId, input)
    }),
))
