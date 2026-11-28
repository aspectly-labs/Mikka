import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { updateWorkspaceMcpSchema } from '@/lib/plugins/contracts'
import { pluginBody, pluginResponse, pluginUuidParam } from '@/lib/plugins/http'
import { workspaceMcpServers } from '@/lib/plugins/runtime'
import { defineRoute } from '@/lib/primitives/define-route'

type Params = { workspaceId: string; serverId: string }
type Context = { params: Promise<Params> }

const unguardedGET = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  return workspaceMcpServers.detail(userId, await pluginUuidParam(ctx, 'workspaceId'), await pluginUuidParam(ctx, 'serverId'))
}))
// Name, endpoint, key, credential, environment, Enabled and the connection mode (any member, as Capy).
const unguardedPATCH = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  return workspaceMcpServers.update(userId, await pluginUuidParam(ctx, 'workspaceId'), await pluginUuidParam(ctx, 'serverId'), await pluginBody(request, updateWorkspaceMcpSchema))
}))
const unguardedDELETE = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  return workspaceMcpServers.remove(userId, await pluginUuidParam(ctx, 'workspaceId'), await pluginUuidParam(ctx, 'serverId'))
}))

const route = '/api/workspaces/[workspaceId]/mcp-servers/[serverId]'
export const GET = defineRoute<'session','none',Params>(
  { route, auth: 'session', origin: 'any', workspace: 'none', freshSession: true },
  ({ request, params }) => unguardedGET(request, { params: Promise.resolve(params) }),
)
export const PATCH = defineRoute<'session','none',Params>(
  { route, auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', freshSession: true },
  ({ request, params }) => unguardedPATCH(request, { params: Promise.resolve(params) }),
)
export const DELETE = defineRoute<'session','none',Params>(
  { route, auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', freshSession: true },
  ({ request, params }) => unguardedDELETE(request, { params: Promise.resolve(params) }),
)
