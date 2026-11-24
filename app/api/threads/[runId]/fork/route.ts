import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/primitives/define-route'
import { spawnThread, ThreadSpawnConflictError } from '@/lib/thread-lifecycle'

export const maxDuration = 60

const idempotencyKeySchema = z.string().trim().min(1).max(128)

const bodySchema = z.object({
  mode: z.enum(['full', 'summary']).default('full'),
  fromMessageId: z.uuid().nullish(),
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict()

export const POST = defineRoute<'session', 'pat-scoped', { runId: string }>(
  {
    route: '/api/threads/[runId]/fork',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    write: true,
  },
  async ({ request, params, user }) => {
    const respond = (body: unknown, status: number) => RouteResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
    try {
      if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'Invalid origin' }, 403)
      const runId = z.uuid().parse(params.runId)
      const input = bodySchema.parse(await request.json())
      const headerRaw = request.headers.get('idempotency-key')
      const headerKey = headerRaw === null ? undefined : idempotencyKeySchema.parse(headerRaw)
      if (headerKey && input.idempotencyKey && headerKey !== input.idempotencyKey) {
        return respond({ error: 'Invalid request' }, 400)
      }
      const idempotencyKey = headerKey ?? input.idempotencyKey ?? null
      const run = await spawnThread(user, runId, { relation: 'fork', mode: input.mode, fromMessageId: input.fromMessageId, idempotencyKey })
      if (!run) return respond({ error: 'threadNotFound' }, 404)
      return respond({ run }, 201)
    } catch (error) {
      if (error instanceof ThreadSpawnConflictError) return respond({ error: error.code }, 409)
      if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
      return respond({ error: 'Thread fork unavailable' }, 503)
    }
  },
)
