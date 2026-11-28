import { RouteResponse } from '@/lib/server-runtime/server'
import { afterJob } from '@/lib/background'
import { z } from 'zod'
import type { ApiSession } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { WorkspaceError } from '@/lib/workspace-error'
import { resolveSuggestionStartWorkspace, startSuggestion } from '@/lib/cloud-computer/suggestions'
import { ComputerError } from '@/lib/computer/store'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { defineRoute } from '@/lib/primitives/define-route'
async function handlePOST(request: Request, session: ApiSession, { params }: { params: Promise<{ id: string }> }) {
  const respond = (value: unknown, status: number) => RouteResponse.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'Invalid origin' }, 403)
    const id = z.uuid().parse((await params).id)
    const workspaceId =
      (await resolveSuggestionStartWorkspace(pool, session.user, id))
      ?? (await loadWorkspaceContext(undefined, session.user)).workspace.id
    const result = await startSuggestion(pool, { userId: session.user.id, workspaceId }, id)
    afterJob('after:coordinator-wake', () => wakeCoordinator(session.user.id))
    return respond(result, 202)
  } catch (error) {
    if (error instanceof ComputerError) return respond({ error: error.message }, error.status)
    if (error instanceof WorkspaceError) return respond({ error: error.code }, error.code === 'workspaceAccessDenied' ? 403 : 409)
    if (error instanceof z.ZodError) return respond({ error: 'Invalid suggestion' }, 400)
    return respond({ error: 'Task start unavailable' }, 503)
  }
}

export const POST = defineRoute<'session', 'none', { id: string }>(
  {
    route: '/api/suggestions/[id]/start',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none', write: true,
  },
  async ({ request, session, params }) => handlePOST(request, session, { params: Promise.resolve(params) }),
)
