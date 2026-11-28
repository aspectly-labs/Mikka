import { billingManagementResponse } from '@/lib/billing/management-http'
import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute<'session', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]/billing',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params, session }) =>
    billingManagementResponse(request, { kind: 'organization', id: params.organizationId }, session),
)

export const POST = defineRoute<'session', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]/billing',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params, session }) =>
    billingManagementResponse(request, { kind: 'organization', id: params.organizationId }, session),
)
