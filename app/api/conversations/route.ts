import { respondGroup } from '@/lib/group-conversations-route'
import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute<'session', 'pat-scoped'>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  ({ request, params }) => respondGroup(request, 'conversations'),
)

export const POST = defineRoute<'session', 'pat-scoped'>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    write: true,
  },
  ({ request, params }) => respondGroup(request, 'conversations'),
)
