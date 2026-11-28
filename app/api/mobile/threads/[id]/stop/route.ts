import { z } from 'zod'
import { requestRunStop } from '@/lib/agent-runs'
import { ActionFailureError } from '@/lib/action-error'
import { json } from '@/lib/mobile-api'
import { runOutsideToken } from '@/lib/tokens/scope'
import { defineRoute } from '@/lib/primitives/define-route'
import type { ApiSession } from '@/lib/api-auth'


type Params = { params: Promise<{ id: string }> }

/**
 * `POST /api/mobile/threads/:id/stop`: 停止 a working thread, as the web's
 * stop does (lib/agent-runs.ts requestRunStop: this run and every later
 * attempt of its chain). 409 `runChainEnded` when nothing is left to stop.
 */
async function handlePOST(request: Request, user: ApiSession['user'], { params }: Params) {
  const id = z.uuid().safeParse((await params).id)
  if (!id.success || await runOutsideToken(user, id.data)) return json({ error: 'runNotFound' }, 404)
  try {
    return json(await requestRunStop(user.id, id.data))
  } catch (error) {
    if (error instanceof ActionFailureError && error.code === 'runNotFound') return json({ error: 'runNotFound' }, 404)
    if (error instanceof ActionFailureError && error.code === 'runChainEnded') return json({ error: 'runChainEnded' }, 409)
    throw error
  }
}

export const POST = defineRoute<'mobile-or-session', 'pat-scoped', { id: string }>(
  {
    route: '/api/mobile/threads/[id]/stop',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'pat-scoped', write: true,
  },
  async ({ request, user, params }) => handlePOST(request, user, { params: Promise.resolve(params) }),
)
