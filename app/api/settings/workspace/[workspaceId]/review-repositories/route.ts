import { getCodeReviewRepositories, saveCodeReviewRepository, deleteCodeReviewRepository } from '@/app/actions/review-settings'
import { settingsBody, settingsResponse } from '@/lib/settings/http'
import { withRequestLog } from '@/lib/request-log'
import { freshSessionRoute } from '@/lib/fresh-session'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ workspaceId: string }> }
const GETBody = withRequestLog('/api/settings/workspace/[workspaceId]/review-repositories', (_request: Request, context: Context) =>
  settingsResponse(async () => getCodeReviewRepositories((await context.params).workspaceId)))
const PATCHBody = freshSessionRoute(withRequestLog('/api/settings/workspace/[workspaceId]/review-repositories', (request: Request, context: Context) =>
  settingsResponse(async () => saveCodeReviewRepository((await context.params).workspaceId, await settingsBody(request)))))
const DELETEBody = freshSessionRoute(withRequestLog('/api/settings/workspace/[workspaceId]/review-repositories', (request: Request, context: Context) =>
  settingsResponse(async () => deleteCodeReviewRepository((await context.params).workspaceId, await settingsBody(request)))))

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

export const DELETE = defineRoute<'session', 'pat-scoped', { workspaceId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    workspaceId: ({ params }) => params.workspaceId,
    freshSession: true,
  },
  ({ request, params }) => DELETEBody(request, { params: Promise.resolve(params) }),
)
