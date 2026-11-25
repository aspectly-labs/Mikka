import { factoryHumanWorkspaceResponse } from '@/lib/factory/workspace-http'
import { RouteResponse } from '@/lib/server-runtime/server'
import { factoryLifecycleEnabled } from '@/lib/factory/runtime'
import { factoryDispatchRecovery } from '@/lib/factory/dispatch-recovery-server'
import { handleFactoryDispatchRecovery } from '@/lib/factory/dispatch-recovery-http'
import { sameOriginMutationAllowed } from '@/lib/http-security'
import { defineRoute } from '@/lib/primitives/define-route'

export const POST = defineRoute<'human-session-only', 'none', { taskId: string }>(
  {
    auth: 'human-session-only',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  async ({ request, session, params }) => {
    if (!factoryLifecycleEnabled()) return RouteResponse.json({ error: 'factoryLifecycleUnavailable' }, { status: 404 })
    if (!request.headers.has('authorization') && !sameOriginMutationAllowed(request)) {
      return RouteResponse.json({ error: 'originNotAllowed' }, { status: 403 })
    }
    return factoryHumanWorkspaceResponse(session.user, async () => {
      const result = await handleFactoryDispatchRecovery(factoryDispatchRecovery, { userId: session.user.id, taskId: params.taskId, action: 'cloud' })
      return RouteResponse.json(result.body, { status: result.status, headers: result.headers })
    })
  },
)
