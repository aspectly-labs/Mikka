import { z } from 'zod'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { discoverRunWorktree } from '@/lib/coding-workspace/identity'
import { workspaceErrorStatus, workspaceSessionStillValid } from '@/lib/coding-workspace/http'
import { defineRoute } from '@/lib/primitives/define-route'

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const workspaceId = ({ request }: { request: Request }) => new URL(request.url).searchParams.get('workspaceId')

export const GET = defineRoute<'session', 'pat-scoped', { runId: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    workspaceId,
    freshSession: true,
    onWorkspaceError: () => Response.json({ ok: false, code: 'workspace_not_found' }, { status: 404, headers }),
  },
  async ({ request, params, session, user }) => {
    try {
      const runId = z.uuid().parse(params.runId)
      const workspace = await loadWorkspaceContext(new URL(request.url).searchParams.get('workspaceId') ?? undefined, user)
      const { identity } = await discoverRunWorktree(pool, workspacePool, { userId: user.id, workspaceId: workspace.workspace.id }, runId)
      if (!await workspaceSessionStillValid(request, session)) return Response.json({ ok: false, code: 'authRequired' }, { status: 401, headers })
      return Response.json({ ok: true, identity }, { headers })
    } catch (error) {
      if (error instanceof z.ZodError) return Response.json({ ok: false, code: 'workspace_invalid_request' }, { status: 400, headers })
      if (error instanceof WorkspaceError) return Response.json({ ok: false, code: 'workspace_not_found' }, { status: 404, headers })
      if (error instanceof CodingWorkspaceError) return Response.json({ ok: false, code: error.code }, { status: workspaceErrorStatus(error), headers })
      throw error
    }
  },
)
