import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { ComputerError } from '@/lib/computer/store'
import { resolveThreadBrowserViewer } from '@/lib/cloud-computer/subagent-browser'

/** The Browser tab's cloud screen: a short-lived, view-only screencast ticket
 * on the thread's managed Chromium (#2940). A fresh POST per open keeps the
 * token's two-minute life off the wire. */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const respond = (body: unknown, status: number) => RouteResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return respond({ error: 'authRequired' }, 401)
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'Invalid origin' }, 403)
    const runId = z.uuid().parse((await params).runId)
    const context = await loadWorkspaceContext(undefined, session.user)
    return respond(await resolveThreadBrowserViewer({ userId: session.user.id, workspaceId: context.workspace.id, runId }), 200)
  } catch (error) {
    if (error instanceof ComputerError) return respond({ error: error.message }, error.status)
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Thread browser unavailable' }, 503)
  }
}
