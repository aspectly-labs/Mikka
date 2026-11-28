import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { PluginError } from '@/lib/plugins/contracts'
import { mcpToolName } from '@/lib/plugins/connection-contracts'
import { pluginBody, pluginResponse } from '@/lib/plugins/http'
import { personalPlugins, mcpConnections } from '@/lib/plugins/runtime'
import { withRequestLog } from '@/lib/request-log'
import { defineRoute } from '@/lib/primitives/define-route'

const TOOL_PAGE = 50
const inputSchema = z.object({ serverId: z.uuid(), cursor: mcpToolName.optional() }).strict()

const unguardedPOST = freshSessionRoute(withRequestLog('/api/integrations/mcp/refresh', request => pluginResponse(async () => {
  const owner = await pluginActor(request, { humanOnly: true })
  const command = await pluginBody(request, inputSchema)
  const installation = (await personalPlugins.listMcp(owner)).find(server => server.id === command.serverId)
  if (!installation) throw new PluginError('mcpNotFound', 404)
  if (!installation.enabled || installation.transport === 'stdio') throw new PluginError('mcpUnavailable', 409)
  // The legacy refresh endpoint keeps its response while the common check
  // persists a complete tool snapshot and preserves switches across refreshes.
  const checked = command.cursor === undefined ? await mcpConnections.check(owner, command.serverId) :
    await mcpConnections.detail(owner, command.serverId)
  if (checked.status !== 'connected') throw new PluginError('mcpUnavailable', 503)
  const available = checked.tools.filter(tool => tool.available && (command.cursor === undefined || tool.name > command.cursor))
    .map(tool => tool.name).sort()
  const page = available.slice(0, TOOL_PAGE)
  return { serverId: command.serverId, tools: page.map(name => ({ name })),
    nextCursor: available.length > TOOL_PAGE ? page.at(-1) : null }
})))
export const POST = defineRoute(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request }) => unguardedPOST(request),
)
