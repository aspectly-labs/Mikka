import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginBody, pluginResponse, pluginUuidParam } from '@/lib/plugins/http'
import { mcpOAuthStart } from '@/lib/plugins/connection-contracts'
import { workspaceMcpServers } from '@/lib/plugins/runtime'
import { defineRoute } from '@/lib/primitives/define-route'

type Params = { workspaceId: string; serverId: string }
type Context = { params: Promise<Params> }
// Capy's Connect: signs in the workspace's one account ("shared") or the caller's own ("member").
const unguardedPOST = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  await pluginBody(request, mcpOAuthStart)
  return workspaceMcpServers.connect(userId, await pluginUuidParam(ctx, 'workspaceId'), await pluginUuidParam(ctx, 'serverId'))
}))
// Disconnect: the caller's own account ("member"), or the workspace's ("shared").
const unguardedDELETE = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  return workspaceMcpServers.disconnect(userId, await pluginUuidParam(ctx, 'workspaceId'), await pluginUuidParam(ctx, 'serverId'))
}))
const route = '/api/workspaces/[workspaceId]/mcp-servers/[serverId]/connection'
export const POST = defineRoute<'session','none',Params>(
  { route, auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', freshSession: true },
  ({ request, params }) => unguardedPOST(request, { params: Promise.resolve(params) }),
)
export const DELETE = defineRoute<'session','none',Params>(
  { route, auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', freshSession: true },
  ({ request, params }) => unguardedDELETE(request, { params: Promise.resolve(params) }),
)
