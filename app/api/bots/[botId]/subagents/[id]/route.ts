import { subagentRoute } from '@/lib/cloud-computer/route'
import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute<'session', 'pat-scoped', { botId: string; id: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  ({ request, params }) => subagentRoute(request, params.botId, params.id),
)
