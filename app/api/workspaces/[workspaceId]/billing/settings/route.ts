import { apiWorkspaceAllowed } from '@/lib/api-auth'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { WorkspaceError } from '@/lib/workspace-access'
import { readWorkspaceBillingSettings, writeWorkspaceAutoRecharge } from '@/lib/billing/settings'
import { readRequiredJsonBody, requireDeviceApiSession, wsGJsonResponse } from '@/lib/settings/device-policy-http'
import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute<'session', 'pat-scoped', { workspaceId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/billing/settings',
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    workspaceId: ({ params }) => params.workspaceId,
    freshSession: true,
    desktop: true,
  },
  ({ request, params, session }) =>
    wsGJsonResponse(async () => {
      const verified = await requireDeviceApiSession(request, false, session)
      if (!apiWorkspaceAllowed(verified, params.workspaceId)) throw new WorkspaceError('workspaceAccessDenied')
      return readWorkspaceBillingSettings(verified.user.id, params.workspaceId, verified.user[enterprisePrincipal])
    }),
)

const mutateSpec = {
  route: '/api/workspaces/[workspaceId]/billing/settings',
  auth: 'session',
  origin: 'same-origin-or-desktop',
  workspace: 'pat-scoped',
  workspaceId: ({ params }: { params: { workspaceId: string } }) => params.workspaceId,
  freshSession: true,
  // PUT and PATCH are one write; the desktop's billing page sends PATCH.
  desktop: true,
} as const

const mutateHandler = ({ request, params, session }: { request: Request; params: { workspaceId: string }; session: Parameters<typeof apiWorkspaceAllowed>[0] }) =>
  wsGJsonResponse(async () => {
    const verified = await requireDeviceApiSession(request, true, session)
    if (!apiWorkspaceAllowed(verified, params.workspaceId)) throw new WorkspaceError('workspaceAccessDenied')
    const body = await readRequiredJsonBody(request)
    return writeWorkspaceAutoRecharge(verified.user.id, params.workspaceId, body, verified.user[enterprisePrincipal])
  })

export const PUT = defineRoute<'session', 'pat-scoped', { workspaceId: string }>(mutateSpec, mutateHandler)

export const PATCH = defineRoute<'session', 'pat-scoped', { workspaceId: string }>(mutateSpec, mutateHandler)
