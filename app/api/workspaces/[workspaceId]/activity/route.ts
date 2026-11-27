import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceResponse, governanceSession } from '@/lib/governance/http'
import { readWorkspaceSettingsActivity } from '@/lib/settings/workspace-activity'
import { defineRoute } from '@/lib/primitives/define-route'

const GETBody = freshSessionRoute(async (request: Request, { params }: { params: Promise<{ workspaceId: string }> }) => governanceResponse(async () => {
  const { workspaceId } = await params
  const session = await governanceSession(request, workspaceId)
  const query = new URL(request.url).searchParams
  return readWorkspaceSettingsActivity(session.user, workspaceId,
    { from: query.get('from'), to: query.get('to') }, query.get('groupBy'))
}))

export const GET = defineRoute<'public', 'none', { workspaceId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/activity',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)
