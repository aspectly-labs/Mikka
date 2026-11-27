import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationSession } from '@/lib/enterprise/http'
import { governanceResponse } from '@/lib/governance/http'
import { removeAllowedDomain } from '@/lib/governance/organization-join-domains'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ organizationId: string; domainId: string }> }

const DELETEBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId, domainId } = await context.params
  const session = await organizationSession(request, organizationId)
  return removeAllowedDomain(organizationId, domainId, session.user.id)
}))

export const DELETE = defineRoute<'public', 'none', { organizationId: string; domainId: string }>(
  {
    route: '/api/organizations/[organizationId]/allowed-domains/[domainId]',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request, params }) => DELETEBody(request, { params: Promise.resolve(params) }),
)
