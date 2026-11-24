import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { bindSlackThread } from '@/lib/thread-lifecycle'

export const maxDuration = 60

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const respond = (body: unknown, status: number) => RouteResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return respond({ error: 'authRequired' }, 401)
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'Invalid origin' }, 403)
    const runId = z.uuid().parse((await params).runId)
    const input = z.object({ linkId: z.uuid(), channelId: z.string().min(1), threadTs: z.string().min(1) }).strict().parse(await request.json())
    const bound = await bindSlackThread(session.user, runId, input)
    if (bound === null) return respond({ error: 'threadNotFound' }, 404)
    return respond({ bound }, 200)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Slack bind unavailable' }, 503)
  }
}
