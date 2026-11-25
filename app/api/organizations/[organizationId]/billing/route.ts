import { freshSessionRoute } from '@/lib/fresh-session'
import { billingManagementResponse } from '@/lib/billing/management-http'
import { defineRoute } from '@/lib/primitives/define-route'
type Context = { params: Promise<{ organizationId: string }> }
const handle = freshSessionRoute(async (request: Request, context: Context) =>
  billingManagementResponse(request, { kind: 'organization', id: (await context.params).organizationId }))
const GETBody = handle
const POSTBody = handle

export const GET = defineRoute<'session', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]/billing',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)

export const POST = defineRoute<'session', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]/billing',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => POSTBody(request, { params: Promise.resolve(params) }),
)
