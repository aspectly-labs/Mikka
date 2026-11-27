import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginBody, pluginResponse, pluginUuidParam } from '@/lib/plugins/http'
import { mcpToolName, mcpToolSetting } from '@/lib/plugins/connection-contracts'
import { PluginError } from '@/lib/plugins/contracts'
import { workspaceMcpServers } from '@/lib/plugins/runtime'
import { defineRoute } from '@/lib/primitives/define-route'

type Params = { workspaceId: string; serverId: string; name: string }
type Context = { params: Promise<Params> }
// One switch for every member's threads; any member may change it (Capy).
const unguardedPATCH = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  const name = mcpToolName.safeParse((await ctx.params).name)
  if (!name.success) throw new PluginError('invalidPluginInput', 400)
  const { enabled, ...options } = await pluginBody(request, mcpToolSetting)
  return workspaceMcpServers.setTool(userId, await pluginUuidParam(ctx, 'workspaceId'), await pluginUuidParam(ctx, 'serverId'), name.data, enabled, options)
}))
export const PATCH = defineRoute<'session','none',Params>(
  { route: '/api/workspaces/[workspaceId]/mcp-servers/[serverId]/tools/[name]', auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', freshSession: true },
  ({ request, params }) => unguardedPATCH(request, { params: Promise.resolve(params) }),
)
