import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginResponse, pluginUuidParam } from '@/lib/plugins/http'
import { PluginError } from '@/lib/plugins/contracts'
import { workspaceMcpServers } from '@/lib/plugins/runtime'
import { defineRoute } from '@/lib/primitives/define-route'

type Params = { workspaceId: string; serverId: string }
type Context = { params: Promise<Params> }
const unguardedGET = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  const query = new URL(request.url).searchParams
  const input = z.object({ code: z.string().min(1).max(4096), state: z.string().min(1).max(256), issuer: z.string().max(2048).optional() }).safeParse({
    code: query.get('code'), state: query.get('state'), issuer: query.get('iss') ?? undefined,
  })
  if (!input.success) throw new PluginError('mcpOAuthStateInvalid', 400)
  return workspaceMcpServers.callback(userId, await pluginUuidParam(ctx, 'workspaceId'), await pluginUuidParam(ctx, 'serverId'), input.data)
}))
export const GET = defineRoute<'session','none',Params>(
  { route: '/api/workspaces/[workspaceId]/mcp-servers/[serverId]/oauth/callback', auth: 'session', origin: 'any', workspace: 'none', freshSession: true },
  ({ request, params }) => unguardedGET(request, { params: Promise.resolve(params) }),
)
