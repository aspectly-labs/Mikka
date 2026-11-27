import { billingManagementResponse } from '@/lib/billing/management-http'
import { defineRoute } from '@/lib/primitives/define-route'

type Params = { workspaceId: string }

export const GET = defineRoute<'session', 'pat-scoped', Params>(
  {
    route: '/api/workspaces/[workspaceId]/billing',
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    freshSession: true,
    workspaceId: ({ params }) => params.workspaceId,
    desktop: true,
  },
  ({ request, params, session }) =>
    billingManagementResponse(request, { kind: 'workspace', id: params.workspaceId }, session),
)

export const POST = defineRoute<'session', 'pat-scoped', Params>(
  {
    route: '/api/workspaces/[workspaceId]/billing',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    freshSession: true,
    workspaceId: ({ params }) => params.workspaceId,
    desktop: true,
  },
  ({ request, params, session }) =>
    billingManagementResponse(request, { kind: 'workspace', id: params.workspaceId }, session),
)
