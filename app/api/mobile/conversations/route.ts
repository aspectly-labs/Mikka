import { directoryInput } from '@/lib/conversation-directory-input'
import { conversationDirectory, conversationSidebar } from '@/lib/conversation-directory'
import { pool } from '@/lib/db'
import { json } from '@/lib/mobile-api'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'
import { defineRoute } from '@/lib/primitives/define-route'
import type { ApiSession } from '@/lib/api-auth'

async function handleGET(request: Request, user: ApiSession['user']) {
  const params = new URL(request.url).searchParams
  const workspaceId = await effectiveRequestWorkspace(user)
  if (!workspaceId || params.get('workspaceId') !== workspaceId) return json({ error: 'workspaceAccessDenied' }, 403)
  if (params.get('view') === 'botChildren') {
    const bot = directoryInput.shape.botId.unwrap().safeParse(params.get('botId'))
    if (!bot.success) return json({ error: 'invalidInput' }, 422)
    const groups = await conversationSidebar(pool, user, workspaceId, bot.data)
    return json({ workspaceId, botId: bot.data, ...(groups[bot.data] ?? { items: [], more: false, unreadCount: 0 }) })
  }
  const pinned = params.get('pinned')
  const archived = params.get('archived')
  if ((pinned !== null && pinned !== 'true' && pinned !== 'false') ||
      (archived !== null && archived !== 'true' && archived !== 'false' && archived !== 'any')) return json({ error: 'invalidInput' }, 422)
  const raw = {
    search: params.get('search') ?? '', state: params.get('state') ?? 'all', archived: archived === 'any' ? 'any' : archived === 'true',
    pullState: params.get('pullState') ?? 'all',
    botId: params.get('botId') ?? undefined,
    cursor: params.has('after') || params.has('at') || params.has('afterKind') || pinned !== null
      ? { id: params.get('after'), kind: params.get('afterKind') ?? undefined, at: params.get('at'), pinned: pinned === null ? null : pinned === 'true' } : undefined,
  }
  const input = directoryInput.safeParse(raw)
  if (!input.success) return json({ error: 'invalidInput' }, 422)
  return json({ workspaceId, ...await conversationDirectory(pool, user, workspaceId, input.data) })
}

export const GET = defineRoute<'mobile-or-session', 'pat-scoped'>(
  {
    route: '/api/mobile/conversations',
    auth: 'mobile-or-session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  async ({ request, user }) => handleGET(request, user),
)
