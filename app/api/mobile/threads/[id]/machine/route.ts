import { z } from 'zod'
import { pool } from '@/lib/db'
import { json } from '@/lib/mobile-api'
import { mobileThread } from '@/lib/mobile-threads'
import { readRunChain } from '@/lib/run-chain'
import { runOutsideToken } from '@/lib/tokens/scope'
import { readThreadMachine } from '@/lib/thread-machine-view'
import { defineRoute } from '@/lib/primitives/define-route'
import type { ApiSession } from '@/lib/api-auth'


type Params = { params: Promise<{ id: string }> }

/**
 * `GET /api/mobile/threads/:id/machine`: which machine the thread runs on, read when the person taps the
 * icon in its title (docs/design/thread-run-location.md). Only the owner's own thread; null when it has none.
 */
async function handleGET(request: Request, user: ApiSession['user'], { params }: Params) {
  const id = z.uuid().safeParse((await params).id)
  if (!id.success || await runOutsideToken(user, id.data)) return json({ error: 'runNotFound' }, 404)
  // mobileThread reads only the person's own runs.
  if (!await mobileThread(user.id, id.data)) return json({ error: 'runNotFound' }, 404)
  const chain = await readRunChain(pool, user.id, id.data)
  const runIds = chain ? chain.attempts.map(attempt => attempt.runId) : [id.data]
  return json({ machine: await readThreadMachine(pool, user.id, runIds) })
}

export const GET = defineRoute<'mobile-or-session', 'pat-scoped', { id: string }>(
  {
    route: '/api/mobile/threads/[id]/machine',
    auth: 'mobile-or-session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  async ({ request, user, params }) => handleGET(request, user, { params: Promise.resolve(params) }),
)
