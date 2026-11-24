import { RouteResponse } from '@/lib/server-runtime/server'
import { sharedThread } from '@/lib/thread-lifecycle'

export const maxDuration = 60

// Public read-only projection: the token is the only credential, and a revoked
// or deleted thread answers the same 404 as a token that never existed.
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const thread = await sharedThread((await params).token)
  if (!thread) return RouteResponse.json({ error: 'shareNotFound' }, { status: 404 })
  return RouteResponse.json({ thread })
}
