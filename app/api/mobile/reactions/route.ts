import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { reactionsFor, visibleReactableMessages, REACTIONS, setReaction } from '@/lib/reactions'
import { messagesOutsideToken } from '@/lib/tokens/scope'


const input = z.object({ messageId: z.uuid(), emoji: z.enum(REACTIONS).nullable() }).strict()

/**
 * `POST /api/mobile/reactions` with `{ messageId, emoji }`: the person's reaction to a message,
 * or none (`emoji: null`). Returns `{ ok: true, messageId, reactions }` with the updated counts.
 */
async function handlePOST(request: Request) {
  if (!writeAllowed(request)) return forbiddenOrigin()
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
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
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const ids = z.array(z.uuid()).max(100).safeParse((new URL(request.url).searchParams.get('ids') ?? '').split(',').filter(Boolean))
  if (!ids.success) return json({ error: 'invalidIds' }, 400)
  const outside = await messagesOutsideToken(user, ids.data)
  return json({ reactions: await reactionsFor(user.id, await visibleReactableMessages(user.id, ids.data.filter(id => !outside.has(id)))) })
}

export const GET = withRequestLog('/api/mobile/reactions', handleGET)
export const POST = withRequestLog('/api/mobile/reactions', handlePOST)
