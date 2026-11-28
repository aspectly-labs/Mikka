import { respondGroupDecisionReplay } from '@/lib/group-conversations-route'
import { defineRoute } from '@/lib/primitives/define-route'
export const maxDuration = 60

export const POST = defineRoute<'session', 'pat-scoped', { id: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    write: true,
  },
  ({ request, params }) => respondGroupDecisionReplay(request, params.id),
)
