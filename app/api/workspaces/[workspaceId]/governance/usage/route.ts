import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceResponse, governanceSession } from '@/lib/governance/http'
import { exportWorkspaceUsage, readWorkspaceUsage } from '@/lib/governance/usage'
import { defineRoute } from '@/lib/primitives/define-route'
type Context = { params: Promise<{ workspaceId: string }> }

const GETBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { workspaceId } = await context.params
  const session = await governanceSession(request, workspaceId)
  const params = new URL(request.url).searchParams
  const range = { from: params.get('from'), to: params.get('to') }
  // Omitted keeps the response shape existing callers already read.
  const groupBy = params.get('groupBy')
  if (params.get('format') === 'csv') return new Response(await exportWorkspaceUsage(workspaceId, session.user, range, groupBy), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="workspace-usage.csv"', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
  })
  return readWorkspaceUsage(workspaceId, session.user, range, groupBy)
}))

export const GET = defineRoute<'public', 'none', { workspaceId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/governance/usage',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)
