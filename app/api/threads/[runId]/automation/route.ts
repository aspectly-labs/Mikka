import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/primitives/define-route'
import { threadToAutomation } from '@/lib/thread-lifecycle'
import { ScheduleError } from '@/lib/schedules/contract'

export const maxDuration = 60

export const POST = defineRoute<'session', 'pat-scoped', { runId: string }>(
  {
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
      const { definition } = z.object({ definition: z.record(z.string(), z.unknown()) }).strict().parse(await request.json())
      const result = await threadToAutomation(user, runId, definition)
      if (result === 'forbidden') return respond({ error: 'scheduleRejected' }, 403)
      if (!result) return respond({ error: 'threadNotFound' }, 404)
      return respond(result, 201)
    } catch (error) {
      if (error instanceof ScheduleError) return respond({ error: error.message }, error.status)
      if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
      return respond({ error: 'Thread automation unavailable' }, 503)
    }
  },
)
