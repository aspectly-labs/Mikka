import { freshSessionRoute } from '@/lib/fresh-session'
import { withRequestLog } from '@/lib/request-log'
import { pluginActor } from '@/lib/plugins/actor'
import { shareMcpSchema } from '@/lib/plugins/contracts'
import { pluginBody, pluginResponse } from '@/lib/plugins/http'
import { workspaceMcp } from '@/lib/plugins/runtime'
import { defineRoute } from '@/lib/primitives/define-route'

// Only an ordinary, fresh owner session may grant access. No Agent/tool route calls share().
const unguardedPATCH = freshSessionRoute(withRequestLog('/api/integrations/mcp/shares', request => pluginResponse(async () => {
  const userId = await pluginActor(request, { humanOnly: true })
  return workspaceMcp.share(userId, await pluginBody(request, shareMcpSchema))
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
