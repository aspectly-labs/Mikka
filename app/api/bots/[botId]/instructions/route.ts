import { getBotInstructions, updateBotInstructions } from '@/app/actions/instructions'
import { settingsBody } from '@/lib/settings/http'
import { runInstructionRoute } from '@/lib/settings/instructions-http'
import { ActionFailureError } from '@/lib/action-error'
import { defineRoute } from '@/lib/primitives/define-route'

const workspaceId = ({ request }: { request: Request }) => new URL(request.url).searchParams.get('workspaceId')

export const GET = defineRoute<'session', 'pat-scoped', { botId: string }>(
  {
    route: '/api/bots/[botId]/instructions',
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    workspaceId,
  },
  ({ request, params }) => runInstructionRoute(request, async () =>
    getBotInstructions(params.botId, new URL(request.url).searchParams.get('workspaceId') ?? undefined)),
)

export const PATCH = defineRoute<'session', 'pat-scoped', { botId: string }>(
  {
    route: '/api/bots/[botId]/instructions',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    workspaceId,
    freshSession: true,
    write: true,
  },
  ({ request, params }) => runInstructionRoute(request, async () => {
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
      botId: params.botId,
      instructions,
      workspaceId: (bodyWorkspaceId as string | undefined) ?? queryWorkspaceId,
    })
  }),
)
