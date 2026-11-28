import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { createMcpSchema, deletePluginSchema, updateMcpSchema } from '@/lib/plugins/contracts'
import { pluginBody, pluginResponse } from '@/lib/plugins/http'
import { personalPlugins } from '@/lib/plugins/runtime'
import { PluginError } from '@/lib/plugins/contracts'
import { z } from 'zod'
import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute(
  {
    route: '/api/integrations/mcp',
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    freshSession: true,
  },
  ({ request, session }) => pluginResponse(async () => {
    const userId = await pluginActor(request, {}, session)
    const workspaceId = new URL(request.url).searchParams.get('workspaceId')
    if (workspaceId !== null) {
      if (!z.uuid().safeParse(workspaceId).success) throw new PluginError('invalidPluginInput', 400)
      return (await import('@/lib/plugins/runtime')).workspaceMcp.list(userId, workspaceId)
    }
    const servers = await personalPlugins.listMcp(userId)
    return { servers, count: servers.length }
  }),
)

const POSTBody = defineRoute(
  {
    route: '/api/integrations/mcp',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    freshSession: true,
  },
  ({ request, session }) => pluginResponse(async () => {
    const userId = await pluginActor(request, {}, session)
    return { server: await personalPlugins.createMcp(userId, await pluginBody(request, createMcpSchema)) }
  }, 201),
)

const PATCHBody = defineRoute(
  {
    route: '/api/integrations/mcp',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    freshSession: true,
  },
  ({ request, session }) => pluginResponse(async () => {
    const userId = await pluginActor(request, {}, session)
    return { server: await personalPlugins.updateMcp(userId, await pluginBody(request, updateMcpSchema)) }
  }),
)

const DELETEBody = defineRoute(
  {
    route: '/api/integrations/mcp',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    freshSession: true,
  },
  ({ request, session }) => pluginResponse(async () => {
    const userId = await pluginActor(request, {}, session)
    await personalPlugins.deleteMcp(userId, (await pluginBody(request, deletePluginSchema)).id)
    return { deleted: true }
  }),
)

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
export const PATCH = freshSessionRoute(PATCHBody)
export const DELETE = freshSessionRoute(DELETEBody)
