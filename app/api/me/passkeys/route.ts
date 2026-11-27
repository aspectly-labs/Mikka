import { freshSessionRoute } from '@/lib/fresh-session'
import { listUserPasskeys, passkeyAccountSession, passkeyRouteResponse } from '@/lib/account/passkeys'
import { defineRoute } from '@/lib/primitives/define-route'

const passkeyUnauthorized = () => Response.json(
  { error: { code: 'unauthorized' } },
  { status: 401, headers: { 'cache-control': 'private, no-store' } },
)

export const GET = freshSessionRoute(defineRoute(
  { auth: 'session', origin: 'any', workspace: 'none', freshSession: true, onAuthFailure: passkeyUnauthorized, desktop: true },
  async ({ request }) => passkeyRouteResponse(async () => {
    const session = await passkeyAccountSession(request)
    return { passkeys: await listUserPasskeys(session.user.id) }
  }),
))
