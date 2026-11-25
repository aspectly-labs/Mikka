import { z } from 'zod'
import { json } from '@/lib/mobile-api'
import { mobileThreadArtifacts } from '@/lib/mobile-thread-artifacts'
import { runOutsideToken } from '@/lib/tokens/scope'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'
import { workspaceSelection } from '@/lib/workspace-selection'
import { defineRoute } from '@/lib/primitives/define-route'
import type { ApiSession } from '@/lib/api-auth'


/**
 * `GET /api/mobile/threads/:id/artifacts`: the thread's Artifact segment on iOS (方案 / PR / 报告 / 截图和录屏), as the
 * web's Artifact tab lists it. Only the person's own thread, within the selected workspace; anything else is 404.
 */
async function handleGET(request: Request, user: ApiSession['user'], { params }: { params: Promise<{ id: string }> }) {
  const id = z.uuid().safeParse((await params).id)
  if (!id.success || await runOutsideToken(user, id.data)) return json({ error: 'runNotFound' }, 404)
  try {
    const selectedWorkspaceId = workspaceSelection(request.headers).present
      ? (await loadWorkspaceContext(undefined, user)).workspace.id : undefined
    const found = await mobileThreadArtifacts(user, id.data, selectedWorkspaceId)
    return found ? json(found) : json({ error: 'runNotFound' }, 404)
  } catch (error) {
    if (error instanceof WorkspaceError) return json({ error: 'runNotFound' }, 404)
    throw error
  }
}

export const GET = defineRoute<'mobile-or-session', 'pat-scoped', { id: string }>(
  {
    route: '/api/mobile/threads/[id]/artifacts',
    auth: 'mobile-or-session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  async ({ request, user, params }) => handleGET(request, user, { params: Promise.resolve(params) }),
)
