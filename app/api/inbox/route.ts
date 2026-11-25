import { auth } from '@/lib/api-auth'
import { inbox } from '@/lib/inbox/runtime'
import { handleInbox } from '@/lib/inbox/http'
import { defineRoute } from '@/lib/primitives/define-route'
async function respond(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  return handleInbox(request, session?.user ?? null, inbox())
}


export const GET = defineRoute<'session', 'none'>(
  { route: '/api/inbox', auth: 'session', origin: 'any', workspace: 'none' },
  async ({ request }) => respond(request),
)

export const POST = defineRoute<'session', 'none'>(
  { route: '/api/inbox', auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', write: true },
  async ({ request }) => respond(request),
)
