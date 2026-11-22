import {
  deleteWorkspaceReviewRule,
  getWorkspaceReviewRules,
  saveWorkspaceReviewRule,
} from '@/app/actions/review-rule-settings'
import { settingsBody, settingsResponse } from '@/lib/settings/http'
import { withRequestLog } from '@/lib/request-log'
import { freshSessionRoute } from '@/lib/fresh-session'

type Context = { params: Promise<{ workspaceId: string }> }

async function optionalDeleteBody(request: Request): Promise<unknown> {
  const text = await request.text()
  if (!text.trim()) return {}
  try { return JSON.parse(text) } catch { return null }
}

export const GET = withRequestLog('/api/settings/workspace/[workspaceId]/review-rules', (_request: Request, context: Context) =>
  settingsResponse(async () => getWorkspaceReviewRules((await context.params).workspaceId)),
)

export const PATCH = freshSessionRoute(
  withRequestLog('/api/settings/workspace/[workspaceId]/review-rules', (request: Request, context: Context) =>
    settingsResponse(async () => saveWorkspaceReviewRule((await context.params).workspaceId, await settingsBody(request))),
  ),
)

export const DELETE = freshSessionRoute(
  withRequestLog('/api/settings/workspace/[workspaceId]/review-rules', (request: Request, context: Context) =>
    settingsResponse(async () => deleteWorkspaceReviewRule((await context.params).workspaceId, await optionalDeleteBody(request))),
  ),
)
