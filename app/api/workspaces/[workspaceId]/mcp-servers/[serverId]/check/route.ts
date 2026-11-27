import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginBody, pluginResponse, pluginUuidParam } from '@/lib/plugins/http'
import { mcpOAuthStart } from '@/lib/plugins/connection-contracts'
import { workspaceMcpServers } from '@/lib/plugins/runtime'
import { defineRoute } from '@/lib/primitives/define-route'

type Params = { workspaceId: string; serverId: string }
type Context = { params: Promise<Params> }
// Refresh the tool list with the workspace's account ("shared") or the caller's own ("member").
const unguardedPOST = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  await pluginBody(request, mcpOAuthStart)
  return workspaceMcpServers.check(userId, await pluginUuidParam(ctx, 'workspaceId'), await pluginUuidParam(ctx, 'serverId'))
}))
export const POST = defineRoute<'session','none',Params>(
  { route: '/api/workspaces/[workspaceId]/mcp-servers/[serverId]/check', auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', freshSession: true },
  ({ request, params }) => unguardedPOST(request, { params: Promise.resolve(params) }),
)
