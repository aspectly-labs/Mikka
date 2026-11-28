import { driveResponse } from '@/lib/drive/server'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 60

export const GET = defineRoute<'session', 'none', { volumeId: string }>(
  {
    route: '/api/drive/volumes/[volumeId]/files',
    auth: 'session',
    origin: 'any',
    workspace: 'none', freshSession: true,
  },
  async ({ request, params, session }) => driveResponse(request, 'file', params, session),
)
