import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/primitives/define-route'
import { cancelStepCall } from '@/lib/thread-steps'

export const maxDuration = 60

// Cancel one tool call (#2937): a harness that supports per-call cancel would
// honour it here; today every harness answers the explicit unsupported error.
export const POST = defineRoute<'session', 'pat-scoped', { runId: string; stepId: string }>(
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
      const result = await cancelStepCall(user, z.uuid().parse(params.runId), params.stepId)
      if (result === 'notFound') return respond({ error: 'stepNotFound' }, 404)
      if (result === 'notRunning') return respond({ error: 'stepNotRunning' }, 409)
      return respond({ error: 'toolCancelUnsupported', supported: false }, 422)
    } catch (error) {
      if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
      return respond({ error: 'Step cancel unavailable' }, 503)
    }
  },
)
