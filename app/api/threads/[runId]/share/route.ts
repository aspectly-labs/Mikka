import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/primitives/define-route'
import { createThreadShare, revokeThreadShares } from '@/lib/thread-lifecycle'

export const maxDuration = 60
const spec = {
  auth: 'session',
  origin: 'same-origin-or-desktop',
  workspace: 'pat-scoped',
  write: true,
} as const

export const POST = defineRoute<'session', 'pat-scoped', { runId: string }>(spec, async ({ request, params, user }) => {
  const respond = (body: unknown, status: number) => RouteResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'Invalid origin' }, 403)
    const share = await createThreadShare(user, z.uuid().parse(params.runId))
    if (!share) return respond({ error: 'threadNotFound' }, 404)
    return respond({ shareId: share.shareId, url: `/threads/shared/${share.token}` }, 201)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Thread share unavailable' }, 503)
  }
})

export const DELETE = defineRoute<'session', 'pat-scoped', { runId: string }>(spec, async ({ request, params, user }) => {
  const respond = (body: unknown, status: number) => RouteResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'Invalid origin' }, 403)
    const revoked = await revokeThreadShares(user, z.uuid().parse(params.runId))
    if (revoked === null) return respond({ error: 'threadNotFound' }, 404)
    return respond({ revoked }, 200)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Thread share unavailable' }, 503)
  }
})
