import { NextResponse } from '@/lib/server-runtime/server'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { factoryHumanStore } from '@/lib/factory/server'
import { handleFactoryExecution } from '@/lib/factory/execution-http'
import { factoryHumanWorkspaceResponse } from '@/lib/factory/workspace-http'
import { factoryLiveScopes } from '@/lib/live/factory'
import { withRequestLog, noteLogUser } from '@/lib/request-log'

/** GET /api/factory/tasks/[taskId]/execution — #3087 canonical stage-execution
 * envelope: one projection over the existing FactoryTask/attempt/run/device/
 * candidate/machine state; no second state machine or table. */
export const GET = withRequestLog('/api/factory/tasks/[taskId]/execution', async (request: Request, context: { params: Promise<{ taskId: string }> }) => {
  const session = await auth.api.getSession({ headers: request.headers })
  noteLogUser(session?.user.id)
  const respond = async () => {
    const { taskId } = await context.params
    const result = await handleFactoryExecution(pool, factoryHumanStore, { userId: session?.user.id ?? null, taskId })
    let liveWorkspaceId: string | null = null
    if (result.status === 200 && session?.user) {
      try { liveWorkspaceId = (await factoryLiveScopes(pool, workspacePool, taskId, session.user.id))?.task.workspaceId ?? null }
      catch { console.warn('[live] Factory task scope unavailable') }
    }
    return NextResponse.json(result.status === 200 ? { ...result.body, liveWorkspaceId } : result.body,
      { status: result.status, headers: { 'Cache-Control': 'private, no-store' } })
  }
  return factoryHumanWorkspaceResponse(session?.user, respond)
})
