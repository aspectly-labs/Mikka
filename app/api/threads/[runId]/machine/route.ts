import { NextResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { ComputerError } from '@/lib/computer/store'
import { threadMachineAction } from '@/lib/cloud-computer/thread-machines'
import { readThreadMachineDetail, rerunThreadMachineSetup } from '@/lib/cloud-computer/thread-machine-detail'
export const maxDuration = 300

/** The Setup tab's machine detail: state, provider specs, metrics, uptime,
 * snapshot and the environment's setup recipe (#2940). */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const respond = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return respond({ error: 'authRequired' }, 401)
    const runId = z.uuid().parse((await params).runId)
    const context = await loadWorkspaceContext(undefined, session.user)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    try {
      return respond(await readThreadMachineDetail(pool, { userId: session.user.id, workspaceId: context.workspace.id }, runId, controller.signal), 200)
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    if (error instanceof ComputerError) return respond({ error: error.message }, error.status)
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Thread machine unavailable' }, 503)
  }
}
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const respond = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return respond({ error: 'authRequired' }, 401)
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'Invalid origin' }, 403)
    const runId = z.uuid().parse((await params).runId)
    const { action } = z.object({ action: z.enum(['pause', 'resume', 'end', 'refresh_runtime', 'setup_rerun']) }).strict().parse(await request.json())
    const context = await loadWorkspaceContext(undefined, session.user)
    if (action === 'setup_rerun') {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 280_000)
      try {
        return respond(await rerunThreadMachineSetup(pool, { userId: session.user.id, workspaceId: context.workspace.id }, runId, controller.signal), 200)
      } finally {
        clearTimeout(timeout)
      }
    }
    return respond(await threadMachineAction(pool, { userId: session.user.id, workspaceId: context.workspace.id }, runId, action), 200)
  } catch (error) {
    if (error instanceof ComputerError) return respond({ error: error.message }, error.status)
    if (error instanceof z.ZodError) return respond({ error: 'Invalid request' }, 400)
    return respond({ error: 'Thread machine unavailable' }, 503)
  }
}
