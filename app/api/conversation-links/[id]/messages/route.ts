import { respondGroup } from '@/lib/group-conversations-route'
import { defineRoute } from '@/lib/primitives/define-route'

/** Membership in the source group grants only the link's bounded DM segment. */

export const GET = defineRoute<'session', 'pat-scoped', { id: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    desktop: true,
  },
  ({ request, params }) => respondGroup(request, 'links', params.id),
)
