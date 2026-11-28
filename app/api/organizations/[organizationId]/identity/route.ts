import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { GovernanceError } from '@/lib/governance/errors'
import { identitySummary, manageIdentity } from '@/lib/enterprise/management'
import { organizationSession, organizationAccountSession } from '@/lib/enterprise/http'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ organizationId: string }> }
const GETBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const session = await organizationSession(request, (await context.params).organizationId)
  return identitySummary((await context.params).organizationId, session.user.id)
}))
const POSTBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const origin = new URL(request.url).origin
  if (request.headers.get('origin') !== origin) throw new GovernanceError('access_denied')
  const session = await organizationAccountSession(request)
  return manageIdentity((await context.params).organizationId, session, await governanceJson(request), origin)
}))

export const GET = defineRoute<'public', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]/identity',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)

export const POST = defineRoute<'public', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]/identity',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => POSTBody(request, { params: Promise.resolve(params) }),
)
