import { driveResponse } from '@/lib/drive/server'
import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute<'session', 'none', { shareId: string }>(
  {
    route: '/api/drive/shares/[shareId]',
    auth: 'session',
    origin: 'any',
    workspace: 'none', freshSession: true,
    desktop: true,
  },
  async ({ request, params, session }) => driveResponse(request, 'shareView', params, session),
)
