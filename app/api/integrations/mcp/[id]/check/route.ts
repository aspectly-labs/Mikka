import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginBody, pluginResponse, pluginUuidParam } from '@/lib/plugins/http'
import { mcpConnections, mcpDeviceChecks } from '@/lib/plugins/runtime'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ id: string }> }

const unguardedPOST = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  const id = await pluginUuidParam(ctx, 'id')
  const input = request.body ? await pluginBody(request, z.object({ deviceId: z.uuid().optional() }).strict()) : {}
  if (input.deviceId) {
    await mcpDeviceChecks.request(userId, id, input.deviceId)
    return mcpConnections.detail(userId, id)
  }
  return mcpConnections.check(userId, id)
}))
export const POST = defineRoute<'session','none',{ id: string }>(
  {
    route: '/api/integrations/mcp/[id]/check',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => unguardedPOST(request, { params: Promise.resolve(params) }),
)
