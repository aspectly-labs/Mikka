import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceMutationSession, governanceResponse } from '@/lib/governance/http'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ workspaceId: string; projectId: string }> }

// Retired with the Project -> repository -> environment bindings (decision 2026-11-26-0110 rule 5): repositories
// belong to an environment, and a repository outside it is admitted by the workspace repository policy. The
// route answers 410 for one release so an older caller gets a coded refusal, then it is removed.
const POSTBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const params = await context.params
  await governanceMutationSession(request, params.workspaceId)
  return Response.json({ error: { code: 'projectBindingsRetired' } }, { status: 410, headers: { 'cache-control': 'private, no-store' } })
}))

export const POST = defineRoute<'public', 'none', { workspaceId: string; projectId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/projects/[projectId]/repos',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => POSTBody(request, { params: Promise.resolve(params) }),
)
