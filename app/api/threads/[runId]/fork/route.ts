import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { spawnThread } from '@/lib/thread-lifecycle'

export const maxDuration = 60

const bodySchema = z.object({
  mode: z.enum(['full', 'summary']).default('full'),
  fromMessageId: z.uuid().nullish(),
}).strict()

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const respond = (body: unknown, status: number) => RouteResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return respond({ error: 'authRequired' }, 401)
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'Invalid origin' }, 403)
    const runId = z.uuid().parse((await params).runId)
    const input = bodySchema.parse(await request.json())
    const run = await spawnThread(session.user, runId, { relation: 'fork', mode: input.mode, fromMessageId: input.fromMessageId })
    if (!run) return respond({ error: 'threadNotFound' }, 404)
    return respond({ run }, 201)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Thread fork unavailable' }, 503)
  }
}
