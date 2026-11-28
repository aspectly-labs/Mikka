import { botRoute } from '@/lib/bot-route'
import { defineRoute } from '@/lib/primitives/define-route'

/** Follow (PUT) or stop following (DELETE) a Bot the person can find. */
const handle = defineRoute<'session', 'pat-scoped', { botId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    write: true,
  },
  ({ request, params }) => botRoute(request, Promise.resolve(params), async ({ userId, workspaceId, botId }) =>
    (await import('@/lib/bot-access')).followBot({ userId, workspaceId }, botId, request.method === 'PUT')),
)
export const PUT = handle
export const DELETE = handle
