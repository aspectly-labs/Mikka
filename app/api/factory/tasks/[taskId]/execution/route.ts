import { RouteResponse } from '@/lib/server-runtime/server'
import { type ApiSession } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { factoryHumanStore } from '@/lib/factory/server'
import { handleFactoryExecution } from '@/lib/factory/execution-http'
import { factoryHumanWorkspaceResponse } from '@/lib/factory/workspace-http'
import { factoryLiveScopes } from '@/lib/live/factory'
import { defineRoute } from '@/lib/primitives/define-route'

/** GET /api/factory/tasks/[taskId]/execution — #3087 canonical stage-execution
 * envelope: one projection over the existing FactoryTask/attempt/run/device/
 * candidate/machine state; no second state machine or table. */

async function handleGET(taskId: string, session: ApiSession) {
  const respond = async () => {
    const result = await handleFactoryExecution(pool, factoryHumanStore, { userId: session.user.id, taskId })
    let liveWorkspaceId: string | null = null
    if (result.status === 200) {
      try { liveWorkspaceId = (await factoryLiveScopes(pool, workspacePool, taskId, session.user.id))?.task.workspaceId ?? null }
      catch { console.warn('[live] Factory task scope unavailable') }
    }
    return RouteResponse.json(result.status === 200 ? { ...result.body, liveWorkspaceId } : result.body,
      { status: result.status, headers: { 'Cache-Control': 'private, no-store' } })
  }
  return factoryHumanWorkspaceResponse(session.user, respond)
}

export const GET = defineRoute<'session', 'none', { taskId: string }>(
  {
    route: '/api/factory/tasks/[taskId]/execution',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
  },
  ({ params, session }) => handleGET(params.taskId, session),
)
