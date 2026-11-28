import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginBody, pluginResponse, pluginUuidParam } from '@/lib/plugins/http'
import { mcpOAuthStart } from '@/lib/plugins/connection-contracts'
import { mcpConnections } from '@/lib/plugins/runtime'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ id: string }> }
const unguardedPOST = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  await pluginBody(request, mcpOAuthStart)
  const id = await pluginUuidParam(ctx, 'id')
  const result = await mcpConnections.oauth.start(userId, id)
  return result.authorizationUrl ? result : mcpConnections.check(userId, id)
}))
export const POST = defineRoute<'session','none',{ id: string }>(
  {
    route: '/api/integrations/mcp/[id]/oauth/start',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => unguardedPOST(request, { params: Promise.resolve(params) }),
)
