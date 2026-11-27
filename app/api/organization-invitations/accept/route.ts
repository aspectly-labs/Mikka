import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationAccountSession } from '@/lib/enterprise/http'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { acceptOrganizationInvitation } from '@/lib/governance/organization-invitations'
import { defineRoute } from '@/lib/primitives/define-route'


/** Only explicit, reauthorized team scopes grant member-level workspace access. */
const POSTBody = freshSessionRoute(async (request: Request) => governanceResponse(async () => {
  const session = await organizationAccountSession(request)
  return acceptOrganizationInvitation(await governanceJson(request), session.user, session.session.id)
}))

export const POST = defineRoute<'public', 'none'>(
  {
    route: '/api/organization-invitations/accept',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request }) => POSTBody(request),
)
