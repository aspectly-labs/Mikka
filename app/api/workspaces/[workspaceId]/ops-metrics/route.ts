import { freshSessionRoute } from '@/lib/fresh-session'
import { withRequestLog } from '@/lib/request-log'
import { governanceResponse, governanceSession } from '@/lib/governance/http'
import { readWorkspaceOpsMetrics } from '@/lib/settings/ops-metrics'
import { defineRoute } from '@/lib/primitives/define-route'

type RouteContext = { params: Promise<{ workspaceId: string }> }

const GETBody = freshSessionRoute(withRequestLog('/api/workspaces/[workspaceId]/ops-metrics', async (request: Request, context: RouteContext) =>
  governanceResponse(async () => {
    const { workspaceId } = await context.params
    const session = await governanceSession(request, workspaceId)
    return readWorkspaceOpsMetrics(session.user, workspaceId)
  }),
))

export const GET = defineRoute<'public', 'none', { workspaceId: string }>(
  {
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)
