import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationAccountSession } from '@/lib/enterprise/http'
import { governanceResponse } from '@/lib/governance/http'
import { listArchivedOrganizations } from '@/lib/governance/organizations'
import { defineRoute } from '@/lib/primitives/define-route'


const GETBody = freshSessionRoute(async (request: Request) => governanceResponse(async () => {
  const session = await organizationAccountSession(request)
  return listArchivedOrganizations(session.user.id)
}))

export const GET = defineRoute<'public', 'none'>(
  {
    route: '/api/organizations/deleted',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request }) => GETBody(request),
)
