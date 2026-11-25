// Historical GET image alias remains shared by Bot rendering; generation has retired.
import { defineRoute } from '@/lib/primitives/define-route'
import { handleAgentImagesGET } from './images/route'

export const GET = defineRoute<'session', 'none'>(
  {
    route: '/api/agent',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
  },
  ({ request }) => handleAgentImagesGET(request),
)
