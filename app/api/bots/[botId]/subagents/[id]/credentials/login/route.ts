import { subagentCredentialRoute } from '@/lib/credentials/route'
import { defineRoute } from '@/lib/primitives/define-route'
export const maxDuration = 60

export const POST = defineRoute<'session', 'pat-scoped', { botId: string; id: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    write: true,
  },
  ({ request, params }) => subagentCredentialRoute(request, params.botId, params.id, 'login'),
)
