import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationAccountSession } from '@/lib/enterprise/http'
import { governanceResponse } from '@/lib/governance/http'
import { joinOrganizationByDomain } from '@/lib/governance/organization-join-domains'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ organizationId: string }> }

const POSTBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationAccountSession(request)
  return joinOrganizationByDomain(z.uuid().parse(organizationId), session.user, session.session.id)
}))

export const POST = defineRoute<'public', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]/join-by-domain',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => POSTBody(request, { params: Promise.resolve(params) }),
)
