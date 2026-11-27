import { respondGroup } from '@/lib/group-conversations-route'
import { defineRoute } from '@/lib/primitives/define-route'

/** `POST /api/conversations/:id/stop`: 停止 the group's reply in progress (and any still queued). */

export const POST = defineRoute<'session', 'pat-scoped', { id: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    write: true,
    desktop: true,
  },
  ({ request, params }) => respondGroup(request, 'stop', params.id),
)
