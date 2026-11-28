import { z } from 'zod'
import { json } from '@/lib/mobile-api'
import { setGroupPreference } from '@/lib/chat-preferences'
import { groupOutsideToken } from '@/lib/tokens/scope'
import { defineRoute } from '@/lib/primitives/define-route'
import type { ApiSession } from '@/lib/api-auth'


const change = z.object({ pinned: z.boolean().optional(), hidden: z.boolean().optional(), markedUnread: z.boolean().optional() })
  .strict().refine(value => Object.values(value).some(field => field !== undefined))

/**
 * `PATCH /api/mobile/groups/<id>` with `{ pinned?, hidden?, markedUnread? }`: the person's own state for a group chat
 * they are in, on the home list. 409 `pinLimit` when the pins are full.
 */
async function handlePATCH(request: Request, user: ApiSession['user'], context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const body = change.safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'invalidChange' }, 400)
  if (!z.uuid().safeParse(id).success || await groupOutsideToken(user, id)) return json({ error: 'Not found' }, 404)
  const result = await setGroupPreference(user.id, id, body.data)
  if (result === 'notFound') return json({ error: 'Not found' }, 404)
  if (result === 'pinLimit') return json({ error: 'pinLimit' }, 409)
  return json({ ok: true })
}

export const PATCH = defineRoute<'mobile-or-session', 'pat-scoped', { id: string }>(
  {
    route: '/api/mobile/groups/[id]',
    auth: 'mobile-or-session',
    origin: 'native-mobile-allowed',
    workspace: 'pat-scoped', write: true,
  },
  async ({ request, user, params }) => handlePATCH(request, user, { params: Promise.resolve(params) }),
)
