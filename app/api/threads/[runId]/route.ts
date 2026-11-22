import { NextResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { deleteThread, patchThread } from '@/lib/thread-lifecycle'

export const maxDuration = 60

const patchSchema = z.object({
  taskId: z.uuid().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
}).strict()

export async function PATCH(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const respond = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return respond({ error: 'authRequired' }, 401)
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'Invalid origin' }, 403)
    const runId = z.uuid().parse((await params).runId)
    const input = patchSchema.parse(await request.json())
    const run = await patchThread(session.user, runId, input)
    if (run === 'forbidden') return respond({ error: 'taskNotFound' }, 403)
    if (!run) return respond({ error: 'threadNotFound' }, 404)
    return respond({ run }, 200)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Thread patch unavailable' }, 503)
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const respond = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return respond({ error: 'authRequired' }, 401)
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'Invalid origin' }, 403)
    const runId = z.uuid().parse((await params).runId)
    const deleted = await deleteThread(session.user, runId)
    if (deleted === null) return respond({ error: 'threadNotFound' }, 404)
    return respond({ deleted, recoveryDays: 30 }, 200)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Thread delete unavailable' }, 503)
  }
}
