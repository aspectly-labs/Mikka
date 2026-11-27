import { computerRoute } from '@/lib/computer/route'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 300

export const GET = defineRoute<'session', 'pat-scoped', { botId: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    desktop: true,
  },
  ({ request, params }) => computerRoute(request, params.botId),
)
