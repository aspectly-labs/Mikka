import { respondGroup } from '@/lib/group-conversations-route'
import { defineRoute } from '@/lib/primitives/define-route'

export const PATCH = defineRoute<'session', 'pat-scoped', { id: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    write: true,
  },
  ({ request, params }) => respondGroup(request, 'conversations', params.id),
)
