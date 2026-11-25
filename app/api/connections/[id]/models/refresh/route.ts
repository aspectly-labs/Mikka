import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { refreshConnectionModels } from '@/lib/connection-models'
import { isPatSession, sameOriginMutationAllowed } from '@/lib/http-security'
import { defineRoute } from '@/lib/primitives/define-route'

const respond = (body: unknown, status: number) => RouteResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })

// #2938 (1): manual re-probe — the same LiteLLM model discovery connect/key-change runs.
export const POST = defineRoute<'session', 'pat-scoped', { id: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
  },
  async ({ request, session, params }) => {
    if (!isPatSession(session) && !sameOriginMutationAllowed(request)) {
      return respond({ error: 'originNotAllowed' }, 403)
    }
    try {
      const models = await refreshConnectionModels(session.user as never, z.uuid().parse(params.id))
      return respond({ models }, 200)
    } catch (error) {
      if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
      return respond({ error: error instanceof ActionFailureError ? error.code : 'connectionModelsUnavailable' }, error instanceof ActionFailureError ? 404 : 503)
    }
  },
)
