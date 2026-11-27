import { driveResponse } from '@/lib/drive/server'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 60

export const POST = defineRoute<'session', 'none', { volumeId: string }>(
  {
    route: '/api/drive/volumes/[volumeId]/unarchive',
    auth: 'session',
    origin: 'native-mobile-allowed',
    workspace: 'none', write: true, freshSession: true,
    desktop: true,
  },
  async ({ request, params, session }) => driveResponse(request, 'unarchive', params, session),
)
