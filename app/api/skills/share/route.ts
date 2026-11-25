import { pluginActor } from '@/lib/plugins/actor'
import { pluginBody, pluginResponse } from '@/lib/plugins/http'
import { shareSkillSchema, WorkspaceSkillStore } from '@/lib/plugins/workspace-skill'
import { defineRoute } from '@/lib/primitives/define-route'

async function handlePOST(request: Request) {
  return pluginResponse(async () => {
    const userId = await pluginActor(request)
    // Construct inside the handler so importing this route needs no pool.
    const { pool } = await import('@/lib/db')
    return await new WorkspaceSkillStore(pool).share(userId, await pluginBody(request, shareSkillSchema))
  })
}

export const POST = defineRoute<'session', 'none'>(
  { route: '/api/skills/share', auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', write: true },
  async ({ request }) => handlePOST(request),
)
