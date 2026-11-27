import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationAccountSession } from '@/lib/enterprise/http'
import { governanceResponse } from '@/lib/governance/http'
import { listJoinableOrganizations } from '@/lib/governance/organization-join-domains'
import { defineRoute } from '@/lib/primitives/define-route'

const governanceDenied = () => Response.json(
  { error: { code: 'governance_denied', detail: 'access_denied' } },
  { status: 403, headers: { 'cache-control': 'private, no-store' } },
)

export const GET = freshSessionRoute(defineRoute(
  { auth: 'session', origin: 'any', workspace: 'none', freshSession: true, onAuthFailure: governanceDenied, desktop: true },
  async ({ request }) => governanceResponse(async () => {
    const session = await organizationAccountSession(request)
    return listJoinableOrganizations(session.user, session.session.id)
  }),
))
