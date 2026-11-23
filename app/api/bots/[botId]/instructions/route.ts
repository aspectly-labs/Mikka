import { getBotInstructions, updateBotInstructions } from '@/app/actions/instructions'
import { freshSessionRoute } from '@/lib/fresh-session'
import { withRequestLog } from '@/lib/request-log'
import { settingsBody } from '@/lib/settings/http'
import { runInstructionRoute } from '@/lib/settings/instructions-http'
import { ActionFailureError } from '@/lib/action-error'

type Context = { params: Promise<{ botId: string }> }

export const GET = withRequestLog(
  '/api/bots/[botId]/instructions',
  (request: Request, context: Context) => runInstructionRoute(request, async () => {
    const { botId } = await context.params
    const workspaceId = new URL(request.url).searchParams.get('workspaceId') ?? undefined
    return getBotInstructions(botId, workspaceId)
  }),
)

export const PATCH = freshSessionRoute(withRequestLog(
  '/api/bots/[botId]/instructions',
  (request: Request, context: Context) => runInstructionRoute(request, async () => {
    const { botId } = await context.params
    const queryWorkspaceId = new URL(request.url).searchParams.get('workspaceId') ?? undefined
    const body = await settingsBody(request)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ActionFailureError('validationGeneric')
    }
    const { instructions, workspaceId: bodyWorkspaceId, ...extra } = body as Record<string, unknown>
    if (
      Object.keys(extra).length > 0
      || typeof instructions !== 'string'
      || (bodyWorkspaceId !== undefined && typeof bodyWorkspaceId !== 'string')
      || (queryWorkspaceId !== undefined && bodyWorkspaceId !== undefined && queryWorkspaceId !== bodyWorkspaceId)
    ) {
      throw new ActionFailureError('validationGeneric')
    }
    return updateBotInstructions({
      botId,
      instructions,
      workspaceId: (bodyWorkspaceId as string | undefined) ?? queryWorkspaceId,
    })
  }),
))
