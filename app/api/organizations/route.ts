import { freshSessionRoute } from '@/lib/fresh-session'
import { createOrganization, listArchivedOrganizations, listOrganizations } from '@/lib/governance/organizations'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { organizationAccountSession } from '@/lib/enterprise/http'
import { defineRoute } from '@/lib/primitives/define-route'

const GETBody = freshSessionRoute(async (request: Request) => governanceResponse(async () => {
  const session = await organizationAccountSession(request)
  if (new URL(request.url).searchParams.get('archived') === 'true') {
    return { organizations: await listArchivedOrganizations(session.user.id) }
  }
  return { organizations: await listOrganizations(session.user.id) }
}))
const POSTBody = freshSessionRoute(async (request: Request) => governanceResponse(async () => {
  const session = await organizationAccountSession(request)
  return createOrganization(session.user, await governanceJson(request))
}))

export const GET = defineRoute<'public', 'none'>(
  {
    route: '/api/organizations',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request }) => GETBody(request),
)

export const POST = defineRoute<'public', 'none'>(
  {
    route: '/api/organizations',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request }) => POSTBody(request),
)
