import { RouteResponse } from '@/lib/server-runtime/server'
import { sharedThread } from '@/lib/thread-lifecycle'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 60

// Public read-only projection: the token is the only credential, and a revoked
// or deleted thread answers the same 404 as a token that never existed.
export const GET = defineRoute<'public', 'none', { token: string }>(
  {
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    desktop: true,
  },
  async ({ params }) => {
    const thread = await sharedThread(params.token)
    if (!thread) return RouteResponse.json({ error: 'shareNotFound' }, { status: 404 })
    return RouteResponse.json({ thread })
  },
)
