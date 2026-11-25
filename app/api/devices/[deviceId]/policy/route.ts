import { freshSessionRoute } from '@/lib/fresh-session'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { defineRoute } from '@/lib/primitives/define-route'
import { readDevicePolicy, writeDevicePolicy } from '@/lib/settings/device-policy'
import { readRequiredJsonBody, wsGJsonResponse } from '@/lib/settings/device-policy-http'
import { WorkspaceError } from '@/lib/workspace-access'

export const GET = freshSessionRoute(defineRoute<'session', 'none', { deviceId: string }>(
  { auth: 'session', origin: 'any', workspace: 'none', freshSession: true, route: '/api/devices/[deviceId]/policy' },
  async ({ request, params, session }) =>
    wsGJsonResponse(async () => {
      const workspaceId = new URL(request.url).searchParams.get('workspaceId')
      return readDevicePolicy(
        {
          userId: session.user.id,
          tokenWorkspaceId: session.tokenWorkspaceId,
          principal: session.user[enterprisePrincipal],
        },
        params.deviceId,
        workspaceId,
      )
    }),
))

export const PATCH = freshSessionRoute(defineRoute<'session', 'none', { deviceId: string }>(
  { auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', freshSession: true, route: '/api/devices/[deviceId]/policy' },
  async ({ request, params, session }) =>
    wsGJsonResponse(async () => {
      if (!session.tokenId && request.headers.has('cookie') && !request.headers.has('origin')) {
        throw new WorkspaceError('workspaceAccessDenied')
      }
      const workspaceId = new URL(request.url).searchParams.get('workspaceId')
      const body = await readRequiredJsonBody(request)
      return writeDevicePolicy(
        {
          userId: session.user.id,
          tokenWorkspaceId: session.tokenWorkspaceId,
          principal: session.user[enterprisePrincipal],
        },
        params.deviceId,
        body,
        workspaceId,
      )
    }),
))
