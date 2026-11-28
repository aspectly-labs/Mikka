import { driveResponse } from '@/lib/drive/server'
import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute<'session', 'none', { volumeId: string; shareId: string }>(
  {
    route: '/api/drive/volumes/[volumeId]/shares/[shareId]',
    auth: 'session',
    origin: 'any',
    workspace: 'none', freshSession: true,
  },
  async ({ request, params, session }) => driveResponse(request, 'link', params, session),
)

export const PATCH = defineRoute<'session', 'none', { volumeId: string; shareId: string }>(
  {
    route: '/api/drive/volumes/[volumeId]/shares/[shareId]',
    auth: 'session',
    origin: 'native-mobile-allowed',
    workspace: 'none', write: true, freshSession: true,
  },
  async ({ request, params, session }) => driveResponse(request, 'link', params, session),
)

export const DELETE = defineRoute<'session', 'none', { volumeId: string; shareId: string }>(
  {
    route: '/api/drive/volumes/[volumeId]/shares/[shareId]',
    auth: 'session',
    origin: 'native-mobile-allowed',
    workspace: 'none', write: true, freshSession: true,
  },
  async ({ request, params, session }) => driveResponse(request, 'link', params, session),
)
