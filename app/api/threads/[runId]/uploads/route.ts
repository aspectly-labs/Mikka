import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { WorkspaceError } from '@/lib/workspace-error'
import { workspaceErrorStatus } from '@/lib/http-security'
import { defineRoute } from '@/lib/primitives/define-route'
import { ComputerError } from '@/lib/computer/store'
import { readThreadUploads } from '@/lib/cloud-computer/thread-uploads'

/** The Files tab's 「Uploads」 view: this thread's chat attachments with signed
 * download URLs (#2940). */
export const GET = defineRoute<'session', 'none', { runId: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'none',
  },
  async ({ session, params }) => {
    const respond = (body: unknown, status: number) => RouteResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
    try {
      const runId = z.uuid().parse(params.runId)
      const context = await loadWorkspaceContext(undefined, session.user)
      return respond(await readThreadUploads(pool, { userId: session.user.id, workspaceId: context.workspace.id }, runId), 200)
    } catch (error) {
      if (error instanceof ComputerError) return respond({ error: error.message }, error.status)
      if (error instanceof WorkspaceError) return respond({ error: error.code }, workspaceErrorStatus(error))
      if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
      return respond({ error: 'Thread uploads unavailable' }, 503)
    }
  },
)
