import { freshSessionRoute } from '@/lib/fresh-session'
import { listUserPasskeys, passkeyAccountSession, passkeyRouteResponse } from '@/lib/account/passkeys'

export const GET = freshSessionRoute(async (request: Request) => passkeyRouteResponse(async () => {
  const session = await passkeyAccountSession(request)
  return { passkeys: await listUserPasskeys(session.user.id) }
}))
