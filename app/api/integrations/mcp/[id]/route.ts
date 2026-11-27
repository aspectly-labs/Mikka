import { z } from 'zod'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginResponse, pluginUuidParam } from '@/lib/plugins/http'
import { mcpConnections } from '@/lib/plugins/runtime'
import { PluginError } from '@/lib/plugins/contracts'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ id: string }> }

const unguardedGET = (request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request)
  const workspaceId = new URL(request.url).searchParams.get('workspaceId') ?? undefined
  if (workspaceId && !z.uuid().safeParse(workspaceId).success) throw new PluginError('invalidPluginInput', 400)
  return mcpConnections.detail(userId, await pluginUuidParam(ctx, 'id'), workspaceId)
})
export const GET = defineRoute<'session','pat-scoped',{ id: string }>(
  {
    route: '/api/integrations/mcp/[id]',
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  ({ request, params }) => unguardedGET(request, { params: Promise.resolve(params) }),
)
