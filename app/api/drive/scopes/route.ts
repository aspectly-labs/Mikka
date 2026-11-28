import { driveResponse } from '@/lib/drive/server'
import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute<'session', 'none'>(
  {
    route: '/api/drive/scopes',
    auth: 'session',
    origin: 'any',
    workspace: 'none', freshSession: true,
  },
  async ({ request, session }) => driveResponse(request, 'scopes', {}, session),
)
