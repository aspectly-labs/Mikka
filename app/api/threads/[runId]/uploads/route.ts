import { NextResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { ComputerError } from '@/lib/computer/store'
import { readThreadUploads } from '@/lib/cloud-computer/thread-uploads'

/** The Files tab's 「Uploads」 view: this thread's chat attachments with signed
 * download URLs (#2940). */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const respond = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return respond({ error: 'authRequired' }, 401)
    const runId = z.uuid().parse((await params).runId)
    const context = await loadWorkspaceContext(undefined, session.user)
    return respond(await readThreadUploads(pool, { userId: session.user.id, workspaceId: context.workspace.id }, runId), 200)
  } catch (error) {
    if (error instanceof ComputerError) return respond({ error: error.message }, error.status)
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Thread uploads unavailable' }, 503)
  }
}
