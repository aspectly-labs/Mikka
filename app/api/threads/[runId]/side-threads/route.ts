import { NextResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { spawnThread } from '@/lib/thread-lifecycle'

export const maxDuration = 60

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const respond = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return respond({ error: 'authRequired' }, 401)
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'Invalid origin' }, 403)
    const runId = z.uuid().parse((await params).runId)
    const { messageId } = z.object({ messageId: z.uuid() }).strict().parse(await request.json())
    const run = await spawnThread(session.user, runId, { relation: 'side', fromMessageId: messageId })
    if (!run) return respond({ error: 'threadNotFound' }, 404)
    return respond({ run }, 201)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Side thread unavailable' }, 503)
  }
}
