import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { createWorkspaceMcpSchema } from '@/lib/plugins/contracts'
import { pluginBody, pluginResponse, pluginUuidParam } from '@/lib/plugins/http'
import { workspaceMcpServers } from '@/lib/plugins/runtime'
import { defineRoute } from '@/lib/primitives/define-route'

// Workspace (organization) MCP servers, as Capy's: any active member lists, adds, edits,
// connects or removes one. Membership is checked live on every request.
type Context = { params: Promise<{ workspaceId: string }> }

const unguardedGET = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  return workspaceMcpServers.list(userId, await pluginUuidParam(ctx, 'workspaceId'))
}))
const unguardedPOST = freshSessionRoute((request: Request, ctx: Context) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  const workspaceId = await pluginUuidParam(ctx, 'workspaceId')
  return { server: await workspaceMcpServers.create(userId, workspaceId, await pluginBody(request, createWorkspaceMcpSchema)) }
}, 201))

export const GET = defineRoute<'session','none',{ workspaceId: string }>(
  { route: '/api/workspaces/[workspaceId]/mcp-servers', auth: 'session', origin: 'any', workspace: 'none', freshSession: true },
  ({ request, params }) => unguardedGET(request, { params: Promise.resolve(params) }),
)
export const POST = defineRoute<'session','none',{ workspaceId: string }>(
  { route: '/api/workspaces/[workspaceId]/mcp-servers', auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', freshSession: true },
  ({ request, params }) => unguardedPOST(request, { params: Promise.resolve(params) }),
)
