import { cloudComputerTasksEnabled } from '@/lib/cloud-computer-flag'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { WorkspaceError } from '@/lib/workspace-error'
import { workspaceErrorStatus } from '@/lib/http-security'
import { defineRoute } from '@/lib/primitives/define-route'

const headers = { 'Cache-Control': 'private, no-store' }
export const GET = defineRoute<'session', 'none', { botId: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'none',
  },
  async ({ session, params }) => {
    if (!cloudComputerTasksEnabled()) return Response.json({ error: 'Cloud computer task unavailable' }, { status: 503, headers })
    const { botId } = params
    if (!z.uuid().safeParse(botId).success) return Response.json({ error: 'Invalid request' }, { status: 400, headers })
    try {
      const context = await loadWorkspaceContext(undefined, session.user)
      const bot = await pool.query('SELECT 1 FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3', [botId, session.user.id, context.workspace.id])
      if (!bot.rowCount) return Response.json({ error: 'Computer not found' }, { status: 404, headers })
      const result = await pool.query('SELECT harness,"agentId","repoId" FROM bot_cloud_runtimes WHERE "botId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 ORDER BY harness', [botId, session.user.id, context.workspace.id])
      return Response.json({ runtimes: result.rows }, { headers })
    } catch (error) {
      if (error instanceof WorkspaceError) return Response.json({ error: error.code }, { status: workspaceErrorStatus(error), headers })
      return Response.json({ error: 'Cloud computer task unavailable' }, { status: 503, headers })
    }
  },
)
