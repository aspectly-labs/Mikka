import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/primitives/define-route'
import { readStepOutput } from '@/lib/thread-steps'

export const maxDuration = 60

// Full tool-call output (#2937), segmented by ?offset=&limit=.
export const GET = defineRoute<'session', 'pat-scoped', { runId: string; stepId: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    desktop: true,
  },
  async ({ request, params, user }) => {
    const respond = (body: unknown, status: number) => RouteResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
    try {
      const query = z.object({
        offset: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(1).max(200000).optional(),
      }).parse(Object.fromEntries(new URL(request.url).searchParams))
      const result = await readStepOutput(user, z.uuid().parse(params.runId), params.stepId, query)
      if (!result) return respond({ error: 'stepNotFound' }, 404)
      return respond(result, 200)
    } catch (error) {
      if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
      return respond({ error: 'Step output unavailable' }, 503)
    }
  },
)
