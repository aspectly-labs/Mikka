import { getWorkspaceSettings, patchWorkspaceSettings } from '@/app/actions/settings'
import { settingsBody, settingsResponse } from '@/lib/settings/http'
import { withRequestLog } from '@/lib/request-log'
import { freshSessionRoute } from '@/lib/fresh-session'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ workspaceId: string }> }
const GETBody = withRequestLog('/api/settings/workspace/[workspaceId]', (request: Request, context: Context) =>
  settingsResponse(async () => getWorkspaceSettings((await context.params).workspaceId)))
const PATCHBody = freshSessionRoute(withRequestLog('/api/settings/workspace/[workspaceId]', (request: Request, context: Context) =>
  settingsResponse(async () => patchWorkspaceSettings((await context.params).workspaceId, await settingsBody(request)))))

export const GET = defineRoute<'session', 'pat-scoped', { workspaceId: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    workspaceId: ({ params }) => params.workspaceId,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)

export const PATCH = defineRoute<'session', 'pat-scoped', { workspaceId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    workspaceId: ({ params }) => params.workspaceId,
    freshSession: true,
  },
  ({ request, params }) => PATCHBody(request, { params: Promise.resolve(params) }),
)
