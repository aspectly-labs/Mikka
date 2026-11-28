import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { openChatBotId } from '@/lib/coordinator/coordinator-bot'
import { stopChatTurn } from '@/lib/coordinator/stop-turn'
import { json } from '@/lib/mobile-api'
import { defineRoute } from '@/lib/primitives/define-route'
import type { ApiSession } from '@/lib/api-auth'


/** `POST /api/mobile/chat/stop` with `{ botId? }`: 停止 the turn working in the chat with the Coordinator (no `botId`) or one of the person's bots. */
async function handlePOST(request: Request, user: ApiSession['user']) {
  const parsed = z.object({ botId: z.uuid().nullable().optional() }).safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return json({ error: 'invalidBot' }, 400)
  const botId = parsed.data.botId ?? null
  if (botId) {
    // Only the person's own bot; a token bound to a workspace reaches that workspace's bots only.
    const workspace = typeof user[tokenWorkspace] === 'string' ? user[tokenWorkspace] : null
    const [bot] = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.id, botId), eq(bots.ownerId, user.id), ...(workspace ? [eq(bots.workspaceId, workspace)] : []))).limit(1)
    if (!bot) return json({ error: 'botNotFound' }, 404)
  }
  return json({ stopped: await stopChatTurn(user.id, await openChatBotId(user, botId)) })
}

export const POST = defineRoute<'mobile-or-session', 'pat-scoped'>(
  {
    route: '/api/mobile/chat/stop',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'pat-scoped', write: true,
  },
  async ({ request, user }) => handlePOST(request, user),
)
