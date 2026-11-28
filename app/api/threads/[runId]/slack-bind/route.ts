import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/primitives/define-route'
import { bindSlackThread } from '@/lib/thread-lifecycle'
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
    const input = z.object({ linkId: z.uuid(), channelId: z.string().min(1), threadTs: z.string().min(1) }).strict().parse(await request.json())
    const bound = await bindSlackThread(user, runId, input)
    if (bound === null) return respond({ error: 'threadNotFound' }, 404)
    return respond({ bound }, 200)
    } catch (error) {
      if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
      return respond({ error: 'Slack bind unavailable' }, 503)
    }
  },
)
