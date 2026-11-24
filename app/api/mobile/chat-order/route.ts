import { z } from 'zod'
import { MAX_PINNED_CHATS, setChatOrder } from '@/lib/chat-preferences'
import { json } from '@/lib/mobile-api'
import { defineRoute } from '@/lib/primitives/define-route'
import { botOutsideToken, groupOutsideToken } from '@/lib/tokens/scope'

const key = z.object({ kind: z.enum(['bot', 'group']), id: z.uuid() })
const order = z.object({ pinned: z.array(key).max(MAX_PINNED_CHATS), list: z.array(key).max(500) }).strict()

/**
 * `PUT /api/mobile/chat-order` with `{ pinned, list }`, each a list of `{ kind, id }`: a drag's result on the home
 * list. The chats in `pinned` are pinned in that order, the others unpinned in theirs. 404 when any chat is not the
 * person's; 409 `pinLimit` past the pin limit.
 */
export const PUT = defineRoute(
  {
    route: '/api/mobile/chat-order',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'pat-scoped',
    write: true,
  },
  async ({ request, user }) => {
    const body = order.safeParse(await request.json().catch(() => null))
    if (!body.success) return json({ error: 'invalidOrder' }, 400)
    for (const chat of [...body.data.pinned, ...body.data.list]) {
      if (await (chat.kind === 'bot' ? botOutsideToken(user, chat.id) : groupOutsideToken(user, chat.id))) {
        return json({ error: 'Not found' }, 404)
      }
    }
    const result = await setChatOrder(user.id, { pinned: body.data.pinned.map(chat => chat.id), list: body.data.list.map(chat => chat.id) })
    if (result === 'notFound') return json({ error: 'Not found' }, 404)
    if (result === 'pinLimit') return json({ error: 'pinLimit' }, 409)
    return json({ ok: true })
  },
)
