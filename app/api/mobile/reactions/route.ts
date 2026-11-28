import { z } from 'zod'
import { json } from '@/lib/mobile-api'
import { reactionsFor, visibleReactableMessages, REACTIONS, setReaction } from '@/lib/reactions'
import { messagesOutsideToken } from '@/lib/tokens/scope'
import { defineRoute } from '@/lib/primitives/define-route'
import type { ApiSession } from '@/lib/api-auth'


const input = z.object({ messageId: z.uuid(), emoji: z.enum(REACTIONS).nullable() }).strict()

/**
 * `POST /api/mobile/reactions` with `{ messageId, emoji }`: the person's reaction to a message,
 * or none (`emoji: null`). Returns `{ ok: true, messageId, reactions }` with the updated counts.
 */
async function handlePOST(request: Request, user: ApiSession['user']) {
  const parsed = input.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalidReaction' }, 400)
  if ((await messagesOutsideToken(user, [parsed.data.messageId])).size || !await setReaction(user.id, parsed.data.messageId, parsed.data.emoji)) return json({ error: 'notFound' }, 404)
  const updated = await reactionsFor(user.id, [parsed.data.messageId])
  return json({ ok: true, messageId: parsed.data.messageId, reactions: updated[parsed.data.messageId] ?? [] })
}

/**
 * `GET /api/mobile/reactions?ids=<id>,<id>`: reactions on up to 100 group-chat
 * or Bot-chat messages. Only messages this person may currently access count;
 * others read as having none.
 */
async function handleGET(request: Request, user: ApiSession['user']) {
  const ids = z.array(z.uuid()).max(100).safeParse((new URL(request.url).searchParams.get('ids') ?? '').split(',').filter(Boolean))
  if (!ids.success) return json({ error: 'invalidIds' }, 400)
  const outside = await messagesOutsideToken(user, ids.data)
  return json({ reactions: await reactionsFor(user.id, await visibleReactableMessages(user.id, ids.data.filter(id => !outside.has(id)))) })
}

export const GET = defineRoute<'mobile-or-session', 'pat-scoped'>(
  {
    route: '/api/mobile/reactions',
    auth: 'mobile-or-session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  async ({ request, user }) => handleGET(request, user),
)

export const POST = defineRoute<'mobile-or-session', 'pat-scoped'>(
  {
    route: '/api/mobile/reactions',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'pat-scoped', write: true,
  },
  async ({ request, user }) => handlePOST(request, user),
)
