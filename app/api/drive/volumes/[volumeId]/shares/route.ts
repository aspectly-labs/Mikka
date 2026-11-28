import { driveResponse } from '@/lib/drive/server'
import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute<'session', 'none', { volumeId: string }>(
  {
    route: '/api/drive/volumes/[volumeId]/shares',
    auth: 'session',
    origin: 'any',
    workspace: 'none', freshSession: true,
  },
  async ({ request, params, session }) => driveResponse(request, 'links', params, session),
)

export const POST = defineRoute<'session', 'none', { volumeId: string }>(
  {
    route: '/api/drive/volumes/[volumeId]/shares',
    auth: 'session',
    origin: 'native-mobile-allowed',
    workspace: 'none', write: true, freshSession: true,
  },
  async ({ request, params, session }) => driveResponse(request, 'links', params, session),
)
