import { listOrganizationDriveSkills } from '@/lib/drive/organization-volumes'
import { organizationSession } from '@/lib/enterprise/http'
import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceResponse } from '@/lib/governance/http'
import { defineRoute } from '@/lib/primitives/define-route'


const GETBody = freshSessionRoute(async (request: Request, context: { params: Promise<{ organizationId: string }> }) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return listOrganizationDriveSkills(organizationId, session.user.id, session.session.id, new URL(request.url).searchParams, request.signal)
}))

export const GET = defineRoute<'public', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]/drive-skills',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)
