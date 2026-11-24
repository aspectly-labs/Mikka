import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { spawnThread, ThreadSpawnConflictError } from '@/lib/thread-lifecycle'

export const maxDuration = 60

const idempotencyKeySchema = z.string().trim().min(1).max(128)

const bodySchema = z.object({
  messageId: z.uuid().nullish(),
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict()

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const respond = (body: unknown, status: number) => RouteResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return respond({ error: 'authRequired' }, 401)
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'Invalid origin' }, 403)
    const runId = z.uuid().parse((await params).runId)
    // `messageId` anchors the side thread at that message; omitted, the branch is the whole thread (#2924 ＋ menu).
    const input = bodySchema.parse(await request.json())
    const headerRaw = request.headers.get('idempotency-key')
    const headerKey = headerRaw === null ? undefined : idempotencyKeySchema.parse(headerRaw)
    if (headerKey && input.idempotencyKey && headerKey !== input.idempotencyKey) {
      return respond({ error: 'Invalid request' }, 400)
    }
    const idempotencyKey = headerKey ?? input.idempotencyKey ?? null
    const run = await spawnThread(session.user, runId, { relation: 'side', fromMessageId: input.messageId, idempotencyKey })
    if (!run) return respond({ error: 'threadNotFound' }, 404)
    return respond({ run }, 201)
  } catch (error) {
    if (error instanceof ThreadSpawnConflictError) return respond({ error: error.code }, 409)
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Side thread unavailable' }, 503)
  }
}
