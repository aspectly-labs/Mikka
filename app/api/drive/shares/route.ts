import { driveResponse } from '@/lib/drive/server'
import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute<'session', 'none'>(
  {
    route: '/api/drive/shares',
    auth: 'session',
    origin: 'any',
    workspace: 'none', freshSession: true,
  },
  async ({ request, session }) => driveResponse(request, 'workspaceLinks', {}, session),
)
