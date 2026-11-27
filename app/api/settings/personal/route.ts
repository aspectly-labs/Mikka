import { getSettings, patchPersonalSettings } from '@/app/actions/settings'
import { settingsBody, settingsResponse, settingsWorkspaceQuery } from '@/lib/settings/http'
import { withRequestLog } from '@/lib/request-log'
import { freshSessionRoute } from '@/lib/fresh-session'
import { defineRoute } from '@/lib/primitives/define-route'
import { selectedWorkspaceId } from '@/lib/workspace-selection'

const GETBody = withRequestLog('/api/settings/personal', request => settingsResponse(() => getSettings(settingsWorkspaceQuery(request))))
const PATCHBody = freshSessionRoute(withRequestLog('/api/settings/personal', request =>
  settingsResponse(async () => patchPersonalSettings(await settingsBody(request), settingsWorkspaceQuery(request)))))

export const GET = defineRoute<'session', 'pat-scoped'>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    workspaceId: ({ request }) => selectedWorkspaceId(new URL(request.url).searchParams.get('workspaceId')) ?? undefined,
  },
  ({ request }) => GETBody(request),
)

export const PATCH = defineRoute<'session', 'pat-scoped'>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    workspaceId: ({ request }) => selectedWorkspaceId(new URL(request.url).searchParams.get('workspaceId')) ?? undefined,
    freshSession: true,
  },
  ({ request }) => PATCHBody(request),
)
