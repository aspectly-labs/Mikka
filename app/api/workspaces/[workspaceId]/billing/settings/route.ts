import { freshSessionRoute } from '@/lib/fresh-session'
import { withRequestLog } from '@/lib/request-log'
import { apiWorkspaceAllowed } from '@/lib/api-auth'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { WorkspaceError } from '@/lib/workspace-access'
import { readWorkspaceBillingSettings, writeWorkspaceAutoRecharge } from '@/lib/billing/settings'
import { readRequiredJsonBody, requireDeviceApiSession, wsGJsonResponse } from '@/lib/settings/device-policy-http'

type RouteContext = { params: Promise<{ workspaceId: string }> }

export const GET = freshSessionRoute(withRequestLog('/api/workspaces/[workspaceId]/billing/settings', async (request: Request, context: RouteContext) =>
  wsGJsonResponse(async () => {
    const session = await requireDeviceApiSession(request, false)
    const { workspaceId } = await context.params
    if (!apiWorkspaceAllowed(session, workspaceId)) throw new WorkspaceError('workspaceAccessDenied')
    return readWorkspaceBillingSettings(session.user.id, workspaceId, session.user[enterprisePrincipal])
  }),
))

const mutate = freshSessionRoute(withRequestLog('/api/workspaces/[workspaceId]/billing/settings', async (request: Request, context: RouteContext) =>
  wsGJsonResponse(async () => {
    const session = await requireDeviceApiSession(request, true)
    const { workspaceId } = await context.params
    if (!apiWorkspaceAllowed(session, workspaceId)) throw new WorkspaceError('workspaceAccessDenied')
    const body = await readRequiredJsonBody(request)
    return writeWorkspaceAutoRecharge(session.user.id, workspaceId, body, session.user[enterprisePrincipal])
  }),
))

export const PUT = mutate
export const PATCH = mutate
