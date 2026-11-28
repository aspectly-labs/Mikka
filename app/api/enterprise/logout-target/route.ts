import { freshSessionRoute } from '@/lib/fresh-session'
import { GovernanceError } from '@/lib/governance/errors'
import { governanceResponse } from '@/lib/governance/http'
import { organizationAccountSession } from '@/lib/enterprise/http'
import { enterpriseLogoutTarget } from '@/lib/enterprise/logout-target'
import { defineRoute } from '@/lib/primitives/define-route'

const governanceDenied = () => Response.json(
  { error: { code: 'governance_denied', detail: 'access_denied' } },
  { status: 403, headers: { 'cache-control': 'private, no-store' } },
)

export const GET = freshSessionRoute(defineRoute(
  { auth: 'session', origin: 'any', workspace: 'none', freshSession: true, onAuthFailure: governanceDenied },
  async ({ request }) => governanceResponse(async () => {
    const session = await organizationAccountSession(request)
    if (new URL(request.url).searchParams.size) throw new GovernanceError('invalid_request')
    return { target: await enterpriseLogoutTarget(session) }
  }),
))
