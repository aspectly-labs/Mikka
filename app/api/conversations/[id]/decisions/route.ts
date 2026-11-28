import { respondGroupDecisionQuality } from '@/lib/group-conversations-route'
import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute<'session', 'pat-scoped', { id: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  ({ request, params }) => respondGroupDecisionQuality(request, params.id),
)

export const POST = defineRoute<'session', 'pat-scoped', { id: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    write: true,
  },
  ({ request, params }) => respondGroupDecisionQuality(request, params.id),
)
