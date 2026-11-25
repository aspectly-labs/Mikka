import { organizationSession } from '@/lib/enterprise/http'
import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { restoreOrganizationMember } from '@/lib/governance/organizations'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ organizationId: string; userId: string }> }

const POSTBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId, userId } = await context.params
  const session = await organizationSession(request, organizationId)
  return restoreOrganizationMember(organizationId, session.user.id, userId, await governanceJson(request))
}))

export const POST = defineRoute<'public', 'none', { organizationId: string; userId: string }>(
  {
    route: '/api/organizations/[organizationId]/members/[userId]/restore',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => POSTBody(request, { params: Promise.resolve(params) }),
)
