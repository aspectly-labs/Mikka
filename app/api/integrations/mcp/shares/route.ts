import { freshSessionRoute } from '@/lib/fresh-session'
import { withRequestLog } from '@/lib/request-log'
import { pluginActor } from '@/lib/plugins/actor'
import { PluginError } from '@/lib/plugins/contracts'
import { pluginResponse } from '@/lib/plugins/http'
import { defineRoute } from '@/lib/primitives/define-route'

// Personal MCP servers are not shareable (decision 2026-11-27-1700). One-release shim for clients
// built before sharing was retired: the same human-session guard, then 410 without touching storage.
// Remove once hosted UI no longer calls PATCH /api/integrations/mcp/shares.
const unguardedPATCH = freshSessionRoute(withRequestLog('/api/integrations/mcp/shares', request => pluginResponse(async () => {
  await pluginActor(request, { humanOnly: true })
  throw new PluginError('mcpSharingRetired', 410)
})))
export const PATCH = defineRoute(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request }) => unguardedPATCH(request),
)
