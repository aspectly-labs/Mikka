import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationSession } from '@/lib/enterprise/http'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { renameOrganizationApiKey } from '@/lib/governance/organization-api-keys'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ organizationId: string; keyId: string }> }

const PATCHBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId, keyId } = await context.params
  const session = await organizationSession(request, organizationId)
  return renameOrganizationApiKey(organizationId, session.user, keyId, await governanceJson(request))
}))

export const PATCH = defineRoute<'public', 'none', { organizationId: string; keyId: string }>(
  {
    route: '/api/organizations/[organizationId]/api-keys/[keyId]',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request, params }) => PATCHBody(request, { params: Promise.resolve(params) }),
)
