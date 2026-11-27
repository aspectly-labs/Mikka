import { RouteResponse } from '@/lib/server-runtime/server'
import { pool } from '@/lib/db'
import { handleRead, requestHost, type ReadRequest } from '@/lib/conversation-reads-store'
import { defineRoute } from '@/lib/primitives/define-route'
import type { ApiSession } from '@/lib/api-auth'

async function respond(request: Request, id: string, method: ReadRequest['method'], session: ApiSession) {
  if (typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    const { respondGroup } = await import('@/lib/group-conversations-route')
    return respondGroup(request, 'read', id)
  }
  const result = await handleRead(pool, {
    // The Coordinator is an ordinary bot (#757): the `coordinator` conversation is the chat of the open workspace's one.
    coordinatorBot: async () => (await import('@/lib/coordinator/coordinator-bot')).openChatBotId(session.user, null),
    method,
    userId: session.user.id,
    conversationId: id,
    origin: request.headers.get('origin'),
    host: requestHost(request.headers.get('x-forwarded-host'), request.headers.get('host') ?? new URL(request.url).host),
    body: method === 'POST' ? await request.text().catch(() => '') : undefined,
  })
  return RouteResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'private, no-store' } })
}

/** `GET /api/conversations/:id/read`: where the person left off, and how many replies came after. */
export const GET = defineRoute<'session', 'pat-scoped', { id: string }>(
  { route: '/api/conversations/[id]/read', auth: 'session', origin: 'any', workspace: 'pat-scoped', desktop: true },
  ({ request, params, session }) => respond(request, params.id, 'GET', session),
)

/** `POST /api/conversations/:id/read` with `{ messageId }`: moves the read position forward (never back). */
export const POST = defineRoute<'session', 'pat-scoped', { id: string }>(
  { route: '/api/conversations/[id]/read', auth: 'session', origin: 'any', workspace: 'pat-scoped', desktop: true },
  ({ request, params, session }) => respond(request, params.id, 'POST', session),
)
