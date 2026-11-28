import { resetPersonalSettings } from '@/app/actions/settings'
import { settingsBody, settingsResponse, settingsWorkspaceQuery } from '@/lib/settings/http'
import { withRequestLog } from '@/lib/request-log'
import { freshSessionRoute } from '@/lib/fresh-session'
import { defineRoute } from '@/lib/primitives/define-route'
import { selectedWorkspaceId } from '@/lib/workspace-selection'

const POSTBody = freshSessionRoute(withRequestLog('/api/settings/personal/reset', request =>
  settingsResponse(async () => resetPersonalSettings(await settingsBody(request), settingsWorkspaceQuery(request)))))

export const POST = defineRoute<'session', 'pat-scoped'>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    workspaceId: ({ request }) => selectedWorkspaceId(new URL(request.url).searchParams.get('workspaceId')) ?? undefined,
    freshSession: true,
  },
  ({ request }) => POSTBody(request),
)
