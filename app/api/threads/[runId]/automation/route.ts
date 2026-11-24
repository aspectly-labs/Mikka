import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { threadToAutomation } from '@/lib/thread-lifecycle'
import { ScheduleError } from '@/lib/schedules/contract'

export const maxDuration = 60

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const respond = (body: unknown, status: number) => RouteResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return respond({ error: 'authRequired' }, 401)
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'Invalid origin' }, 403)
    const runId = z.uuid().parse((await params).runId)
    const { definition } = z.object({ definition: z.record(z.string(), z.unknown()) }).strict().parse(await request.json())
    const result = await threadToAutomation(session.user, runId, definition)
    if (result === 'forbidden') return respond({ error: 'scheduleRejected' }, 403)
    if (!result) return respond({ error: 'threadNotFound' }, 404)
    return respond(result, 201)
  } catch (error) {
    if (error instanceof ScheduleError) return respond({ error: error.message }, error.status)
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Thread automation unavailable' }, 503)
  }
}
