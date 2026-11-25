import { json } from '@/lib/mobile-api'
import { mobileThreads } from '@/lib/mobile-threads'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { defineRoute } from '@/lib/primitives/define-route'
import type { ApiSession } from '@/lib/api-auth'


/** `GET /api/mobile/threads`: the 线程 screen: the person's threads and machines. */
async function handleGET(request: Request, user: ApiSession['user']) {
  // This optional proof routes presence only; PATs retain their ordinary scoped data read.
  const homeScope = user[tokenWorkspace] ? undefined : request.headers.get('x-mikka-presence-scope') ?? undefined
  const workspaceId = await effectiveRequestWorkspace(user)
  return json(await mobileThreads(user.id, 60, homeScope, workspaceId))
}

export const GET = defineRoute<'mobile-or-session', 'pat-scoped'>(
  {
    route: '/api/mobile/threads',
    auth: 'mobile-or-session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  async ({ request, user }) => handleGET(request, user),
)
