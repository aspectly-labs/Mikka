import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import { json } from '@/lib/mobile-api'
import { setChatPreference } from '@/lib/chat-preferences'
import { mobileBot } from '@/lib/mobile-threads'
import { coordinatorBot, openChatBotId } from '@/lib/coordinator/coordinator-bot'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'
import { botOutsideToken } from '@/lib/tokens/scope'
import { defineRoute } from '@/lib/primitives/define-route'
import type { ApiSession } from '@/lib/api-auth'


/** `GET /api/mobile/bots/<id>`: a bot's page, `coordinator` for the Coordinator: its threads, PRs, scheduled tasks, library and the person's 置顶 / 通知 for it. */
async function handleGET(request: Request, user: ApiSession['user'], context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  if (new URL(request.url).searchParams.get('view') === 'notification') {
    if (!z.uuid().safeParse(id).success) return json({ error: 'botNotFound' }, 404)
    const [bot] = await db.select({ workspaceId: bots.workspaceId }).from(bots)
      .where(and(eq(bots.id, id), eq(bots.ownerId, user.id), isNull(bots.archivedAt))).limit(1)
    if (!bot) return json({ error: 'botNotFound' }, 404)
    try {
      const { workspace } = await loadWorkspaceContext(bot.workspaceId, user)
      if (workspace.id === bot.workspaceId) return json({ botId: id, workspaceId: workspace.id })
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error
    }
    return json({ error: 'botNotFound' }, 404)
  }
  const workspace = (await loadWorkspaceContext(undefined, user)).workspace
  // `coordinator` names the Coordinator of the workspace the app has open, an ordinary bot row of that workspace.
  if (id === 'coordinator') { const coordinator = await coordinatorBot(user.id, workspace.id); return json(await mobileBot(user.id, workspace.id, coordinator.botId)) }
  if (!z.uuid().safeParse(id).success) return json({ error: 'Not found' }, 404)
  const [bot] = await db.select({ id: bots.id }).from(bots).where(and(eq(bots.id, id), eq(bots.ownerId, user.id), eq(bots.workspaceId, workspace.id))).limit(1)
  if (!bot) return json({ error: 'Not found' }, 404)
  return json(await mobileBot(user.id, workspace.id, bot.id))
}

const change = z.object({ pinned: z.boolean().optional(), muted: z.boolean().optional(), hidden: z.boolean().optional(), markedUnread: z.boolean().optional() })
  .strict().refine(value => Object.values(value).some(field => field !== undefined))

/**
 * `PATCH /api/mobile/bots/<id>` with `{ pinned?, muted?, hidden?, markedUnread? }`: the person's own state for this chat
 * (`coordinator` too): 置顶, 通知, hidden from the home list, marked unread. 409 `pinLimit` when the pins are full.
 */
async function handlePATCH(request: Request, user: ApiSession['user'], context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const body = change.safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'invalidChange' }, 400)
  if (id !== 'coordinator' && (!z.uuid().safeParse(id).success || await botOutsideToken(user, id))) return json({ error: 'Not found' }, 404)
  const result = await setChatPreference(user.id, await openChatBotId(user, id === 'coordinator' ? null : id), body.data)
  if (result === 'notFound') return json({ error: 'Not found' }, 404)
  if (result === 'pinLimit') return json({ error: 'pinLimit' }, 409)
  return json({ ok: true })
}

export const GET = defineRoute<'mobile-or-session', 'pat-scoped', { id: string }>(
  {
    route: '/api/mobile/bots/[id]',
    auth: 'mobile-or-session',
    origin: 'any',
    workspace: 'pat-scoped',
    desktop: true,
  },
  async ({ request, user, params }) => handleGET(request, user, { params: Promise.resolve(params) }),
)

export const PATCH = defineRoute<'mobile-or-session', 'pat-scoped', { id: string }>(
  {
    route: '/api/mobile/bots/[id]',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'pat-scoped', write: true,
    desktop: true,
  },
  async ({ request, user, params }) => handlePATCH(request, user, { params: Promise.resolve(params) }),
)
