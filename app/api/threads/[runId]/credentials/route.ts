import { threadCredentialRoute } from '@/lib/credentials/route'
import { defineRoute } from '@/lib/primitives/define-route'
export const maxDuration = 60

export const POST = defineRoute<'session', 'pat-scoped', { runId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    write: true,
    desktop: true,
  },
  ({ request, params }) => threadCredentialRoute(request, params.runId, 'submit'),
)
