import { computerRoute } from '@/lib/computer/route'
import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute<'session', 'pat-scoped'>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  ({ request }) => computerRoute(request),
)

export const POST = defineRoute<'session', 'pat-scoped'>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    write: true,
  },
  ({ request }) => computerRoute(request),
)
