import { inbox } from '@/lib/inbox/runtime'
import { handleInbox } from '@/lib/inbox/http'
import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute<'session', 'none'>(
  { route: '/api/inbox', auth: 'session', origin: 'any', workspace: 'none', desktop: true },
  async ({ request, user }) => handleInbox(request, user, inbox()),
)

export const POST = defineRoute<'session', 'none'>(
  { route: '/api/inbox', auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', write: true, desktop: true },
  async ({ request, user }) => handleInbox(request, user, inbox()),
)
