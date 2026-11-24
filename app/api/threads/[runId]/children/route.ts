import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { listThreadChildren } from '@/lib/thread-lifecycle'

export const maxDuration = 60

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const respond = (body: unknown, status: number) => RouteResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return respond({ error: 'authRequired' }, 401)
    const runId = z.uuid().parse((await params).runId)
    const children = await listThreadChildren(session.user, runId)
    if (!children) return respond({ error: 'threadNotFound' }, 404)
    return respond({ children }, 200)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Thread children unavailable' }, 503)
  }
}
