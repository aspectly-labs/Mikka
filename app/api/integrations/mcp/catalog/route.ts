import { freshSessionRoute } from '@/lib/fresh-session'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginBody, pluginResponse } from '@/lib/plugins/http'
import { personalPlugins } from '@/lib/plugins/runtime'
import { addCatalogMcp, installMcpCatalog, searchMcpCatalog } from '@/lib/plugins/mcp-catalog'
import { defineRoute } from '@/lib/primitives/define-route'

const unguardedGET = (request: Request) => pluginResponse(async () => {
  await pluginActor(request)
  const query = new URL(request.url).searchParams
  return searchMcpCatalog(query.get('q') ?? '', query.get('cursor') ?? undefined)
})
const unguardedPOST = freshSessionRoute((request: Request) => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  return { server: await addCatalogMcp(personalPlugins, userId, await pluginBody(request, installMcpCatalog)) }
}, 201))
export const GET = defineRoute(
  {
    route: '/api/integrations/mcp/catalog',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request }) => unguardedGET(request),
)

export const POST = defineRoute(
  {
    route: '/api/integrations/mcp/catalog',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request }) => unguardedPOST(request),
)
