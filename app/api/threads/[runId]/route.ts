import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/primitives/define-route'
import { deleteThread, patchThread } from '@/lib/thread-lifecycle'

export const maxDuration = 60

const patchSchema = z.object({
  taskId: z.uuid().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  folder: z.string().trim().max(60).nullable().optional(),
}).strict()

const spec = {
  auth: 'session',
  origin: 'same-origin-or-desktop',
  workspace: 'pat-scoped',
  write: true,
} as const

export const PATCH = defineRoute<'session', 'pat-scoped', { runId: string }>(spec, async ({ request, params, user }) => {
  const respond = (body: unknown, status: number) => RouteResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'Invalid origin' }, 403)
    const runId = z.uuid().parse(params.runId)
    const input = patchSchema.parse(await request.json())
    const run = await patchThread(user, runId, input)
    if (run === 'forbidden') return respond({ error: 'taskNotFound' }, 403)
    if (!run) return respond({ error: 'threadNotFound' }, 404)
    return respond({ run }, 200)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Thread patch unavailable' }, 503)
  }
})

export const DELETE = defineRoute<'session', 'pat-scoped', { runId: string }>(spec, async ({ request, params, user }) => {
  const respond = (body: unknown, status: number) => RouteResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'Invalid origin' }, 403)
    const runId = z.uuid().parse(params.runId)
    const deleted = await deleteThread(user, runId)
    if (deleted === null) return respond({ error: 'threadNotFound' }, 404)
    return respond({ deleted, recoveryDays: 30 }, 200)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Thread delete unavailable' }, 503)
  }
})
