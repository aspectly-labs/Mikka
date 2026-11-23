import { getInstructionPreview } from '@/app/actions/instructions'
import { withRequestLog } from '@/lib/request-log'
import { runInstructionRoute } from '@/lib/settings/instructions-http'
import { ActionFailureError } from '@/lib/action-error'

const ALLOWED_PARAMS = new Set(['workspaceId', 'environmentId', 'botId'])

export const GET = withRequestLog(
  '/api/settings/instructions/preview',
  (request: Request) => runInstructionRoute(request, async () => {
    const search = new URL(request.url).searchParams
    for (const key of search.keys()) {
      if (!ALLOWED_PARAMS.has(key)) throw new ActionFailureError('validationGeneric')
    }
    const workspaceId = search.get('workspaceId') ?? undefined
    const environmentId = search.get('environmentId') ?? undefined
    const botId = search.get('botId') ?? undefined
    return getInstructionPreview({ workspaceId, environmentId, botId })
  }),
)
