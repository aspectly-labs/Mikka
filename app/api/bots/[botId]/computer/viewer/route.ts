import { computerRoute } from '@/lib/computer/route'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 300

export const POST = defineRoute<'session', 'pat-scoped', { botId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
  },
  ({ request, params }) => computerRoute(request, params.botId, 'viewer'),
)
