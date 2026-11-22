import { getEnvironmentInstructions, updateEnvironmentInstructions } from '@/app/actions/instructions'
import { freshSessionRoute } from '@/lib/fresh-session'
import { withRequestLog } from '@/lib/request-log'
import { settingsBody } from '@/lib/settings/http'
import { runInstructionRoute } from '@/lib/settings/instructions-http'
import { ActionFailureError } from '@/lib/action-error'

type Context = { params: Promise<{ workspaceId: string; environmentId: string }> }

export const GET = withRequestLog(
  '/api/workspaces/[workspaceId]/environments/[environmentId]/instructions',
  (request: Request, context: Context) => runInstructionRoute(request, async () => {
    const { workspaceId, environmentId } = await context.params
    return getEnvironmentInstructions(workspaceId, environmentId)
  }),
)

export const PATCH = freshSessionRoute(withRequestLog(
  '/api/workspaces/[workspaceId]/environments/[environmentId]/instructions',
  (request: Request, context: Context) => runInstructionRoute(request, async () => {
    const { workspaceId, environmentId } = await context.params
    const body = await settingsBody(request)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ActionFailureError('validationGeneric')
    }
    const { instructions, revision, ...extra } = body as Record<string, unknown>
    if (Object.keys(extra).length > 0 || typeof instructions !== 'string') {
      throw new ActionFailureError('validationGeneric')
    }
    return updateEnvironmentInstructions({
      workspaceId,
      environmentId,
      instructions,
      ...(revision === undefined ? {} : { revision: revision as number }),
    })
  }),
))
