import { freshSessionRoute } from '@/lib/fresh-session'
import { withRequestLog } from '@/lib/request-log'
import { pluginActor } from '@/lib/plugins/actor'
import { createMcpSchema, deletePluginSchema, updateMcpSchema } from '@/lib/plugins/contracts'
import { pluginBody, pluginResponse } from '@/lib/plugins/http'
import { personalPlugins } from '@/lib/plugins/runtime'
import { PluginError } from '@/lib/plugins/contracts'
import { z } from 'zod'
import { defineRoute } from '@/lib/primitives/define-route'

const unguardedGET = withRequestLog('/api/integrations/mcp', request => pluginResponse(async () => {
  const userId = await pluginActor(request)
  const workspaceId = new URL(request.url).searchParams.get('workspaceId')
  if (workspaceId !== null) {
    if (!z.uuid().safeParse(workspaceId).success) throw new PluginError('invalidPluginInput', 400)
    return (await import('@/lib/plugins/runtime')).workspaceMcp.list(userId, workspaceId)
  }
  const servers = await personalPlugins.listMcp(userId)
  return { servers, count: servers.length }
}))
const POSTBody = withRequestLog('/api/integrations/mcp', request => pluginResponse(async () => {
  const userId = await pluginActor(request)
  return { server: await personalPlugins.createMcp(userId, await pluginBody(request, createMcpSchema)) }
}, 201))
const PATCHBody = withRequestLog('/api/integrations/mcp', request => pluginResponse(async () => {
  const userId = await pluginActor(request)
  return { server: await personalPlugins.updateMcp(userId, await pluginBody(request, updateMcpSchema)) }
}))
const DELETEBody = withRequestLog('/api/integrations/mcp', request => pluginResponse(async () => {
  const userId = await pluginActor(request)
  await personalPlugins.deleteMcp(userId, (await pluginBody(request, deletePluginSchema)).id)
  return { deleted: true }
}))

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
const unguardedPOST = freshSessionRoute(POSTBody)
const unguardedPATCH = freshSessionRoute(PATCHBody)
const unguardedDELETE = freshSessionRoute(DELETEBody)
export const GET = defineRoute(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    freshSession: true,
  },
  ({ request }) => unguardedGET(request),
)

export const POST = defineRoute(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    freshSession: true,
  },
  ({ request }) => unguardedPOST(request),
)

export const PATCH = defineRoute(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    freshSession: true,
  },
  ({ request }) => unguardedPATCH(request),
)

export const DELETE = defineRoute(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    freshSession: true,
  },
  ({ request }) => unguardedDELETE(request),
)
