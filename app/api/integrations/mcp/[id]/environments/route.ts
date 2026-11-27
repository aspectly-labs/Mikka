import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginBody, pluginResponse, pluginUuidParam } from '@/lib/plugins/http'
import { mcpEnvironmentSettings } from '@/lib/plugins/connection-contracts'
import { mcpConnections } from '@/lib/plugins/runtime'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ id: string }> }
const unguardedPATCH = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  return mcpConnections.setEnvironments(userId, await pluginUuidParam(ctx, 'id'), await pluginBody(request, mcpEnvironmentSettings))
}))
export const PATCH = defineRoute<'session','none',{ id: string }>(
  {
    route: '/api/integrations/mcp/[id]/environments',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request, params }) => unguardedPATCH(request, { params: Promise.resolve(params) }),
)
