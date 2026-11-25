import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationSession } from '@/lib/enterprise/http'
import { governanceResponse } from '@/lib/governance/http'
import { verifyAllowedDomain } from '@/lib/governance/organization-join-domains'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ organizationId: string; domainId: string }> }

const POSTBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId, domainId } = await context.params
  const session = await organizationSession(request, organizationId)
  return verifyAllowedDomain(organizationId, domainId, session.user.id)
}))

export const POST = defineRoute<'public', 'none', { organizationId: string; domainId: string }>(
  {
    route: '/api/organizations/[organizationId]/allowed-domains/[domainId]/verify',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => POSTBody(request, { params: Promise.resolve(params) }),
)
