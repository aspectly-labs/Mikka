import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/primitives/define-route'
import { listThreadChildren } from '@/lib/thread-lifecycle'
export const maxDuration = 60

export const GET = defineRoute<'session', 'pat-scoped', { runId: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    desktop: true,
  },
  async ({ params, user }) => {
    const respond = (body: unknown, status: number) => RouteResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
    try {
      const runId = z.uuid().parse(params.runId)
      const children = await listThreadChildren(user, runId)
      if (!children) return respond({ error: 'threadNotFound' }, 404)
      return respond({ children }, 200)
    } catch (error) {
      if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
      return respond({ error: 'Thread children unavailable' }, 503)
    }
  },
)
