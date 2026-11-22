import { NextResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { createThreadShare, revokeThreadShares } from '@/lib/thread-lifecycle'

export const maxDuration = 60

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const respond = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return respond({ error: 'authRequired' }, 401)
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'Invalid origin' }, 403)
    const runId = z.uuid().parse((await params).runId)
    const share = await createThreadShare(session.user, runId)
    if (!share) return respond({ error: 'threadNotFound' }, 404)
    return respond({ shareId: share.shareId, url: `/threads/shared/${share.token}` }, 201)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Thread share unavailable' }, 503)
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const respond = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return respond({ error: 'authRequired' }, 401)
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'Invalid origin' }, 403)
    const runId = z.uuid().parse((await params).runId)
    const revoked = await revokeThreadShares(session.user, runId)
    if (revoked === null) return respond({ error: 'threadNotFound' }, 404)
    return respond({ revoked }, 200)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Thread share unavailable' }, 503)
  }
}
