import { RouteResponse } from '@/lib/server-runtime/server'
import { defineRoute } from '@/lib/primitives/define-route'
import { readThreadPreview } from '@/lib/thread-preview'

// The 30-second cache is per identity: Vary keeps one signed-in person's
// browser cache from serving the previous owner's reply excerpt.
const headers = { 'Cache-Control': 'private, max-age=30', 'Vary': 'Cookie, Authorization' }

/** The hover card's light read; the projection may cache for 30 seconds (#2935). */
export const GET = defineRoute<'session', 'pat-scoped', { issueId: string }>(
  { auth: 'session', origin: 'any', workspace: 'pat-scoped' },
  async ({ params, user }) => {
    const preview = await readThreadPreview(user, params.issueId)
    if (!preview) return RouteResponse.json({ error: 'threadNotFound' }, { status: 404, headers })
    return RouteResponse.json(preview, { headers })
  },
)
