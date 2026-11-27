import { resetWorkspaceSettings } from '@/app/actions/settings'
import { settingsBody, settingsResponse } from '@/lib/settings/http'
import { withRequestLog } from '@/lib/request-log'
import { freshSessionRoute } from '@/lib/fresh-session'
import { defineRoute } from '@/lib/primitives/define-route'

const POSTBody = freshSessionRoute(withRequestLog('/api/settings/workspace/[workspaceId]/reset',
  (request: Request, context: { params: Promise<{ workspaceId: string }> }) =>
    settingsResponse(async () => resetWorkspaceSettings((await context.params).workspaceId, await settingsBody(request)))))

export const POST = defineRoute<'session', 'pat-scoped', { workspaceId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    workspaceId: ({ params }) => params.workspaceId,
    freshSession: true,
    desktop: true,
  },
  ({ request, params }) => POSTBody(request, { params: Promise.resolve(params) }),
)
