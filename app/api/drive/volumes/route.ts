import { driveResponse } from '@/lib/drive/server'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 60

export const GET = defineRoute<'session', 'none'>(
  {
    route: '/api/drive/volumes',
    auth: 'session',
    origin: 'any',
    workspace: 'none', freshSession: true,
    desktop: true,
  },
  async ({ request, session }) => driveResponse(request, 'volumes', {}, session),
)

export const POST = defineRoute<'session', 'none'>(
  {
    route: '/api/drive/volumes',
    auth: 'session',
    origin: 'native-mobile-allowed',
    workspace: 'none', write: true, freshSession: true,
    desktop: true,
  },
  async ({ request, session }) => driveResponse(request, 'volumes', {}, session),
)
