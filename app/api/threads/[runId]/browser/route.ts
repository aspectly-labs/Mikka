import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { WorkspaceError } from '@/lib/workspace-error'
import { sameOriginMutationAllowed, workspaceErrorStatus } from '@/lib/http-security'
import { defineRoute } from '@/lib/primitives/define-route'
import { ComputerError } from '@/lib/computer/store'
import { resolveThreadBrowserViewer } from '@/lib/cloud-computer/subagent-browser'

/** The Browser tab's cloud screen: a short-lived, view-only screencast ticket
 * on the thread's managed Chromium (#2940). A fresh POST per open keeps the
 * token's two-minute life off the wire. */
export const POST = defineRoute<'session', 'none', { runId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
  },
  async ({ request, session, params }) => {
    const respond = (body: unknown, status: number) => RouteResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
    try {
      if (!sameOriginMutationAllowed(request)) return respond({ error: 'Invalid origin' }, 403)
      const runId = z.uuid().parse(params.runId)
      const context = await loadWorkspaceContext(undefined, session.user)
      return respond(await resolveThreadBrowserViewer({ userId: session.user.id, workspaceId: context.workspace.id, runId }), 200)
    } catch (error) {
      if (error instanceof ComputerError) return respond({ error: error.message }, error.status)
      if (error instanceof WorkspaceError) return respond({ error: error.code }, workspaceErrorStatus(error))
      if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
      return respond({ error: 'Thread browser unavailable' }, 503)
    }
  },
)
