import { freshSessionRoute } from '@/lib/fresh-session'
import { withRequestLog } from '@/lib/request-log'
import { governanceResponse, governanceSession } from '@/lib/governance/http'
import { readWorkspaceOpsMetrics } from '@/lib/settings/ops-metrics'

type RouteContext = { params: Promise<{ workspaceId: string }> }

export const GET = freshSessionRoute(withRequestLog('/api/workspaces/[workspaceId]/ops-metrics', async (request: Request, context: RouteContext) =>
  governanceResponse(async () => {
    const { workspaceId } = await context.params
    const session = await governanceSession(request, workspaceId)
    return readWorkspaceOpsMetrics(session.user, workspaceId)
  }),
))
