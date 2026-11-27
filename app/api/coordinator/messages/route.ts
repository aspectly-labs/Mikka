import { RouteResponse } from '@/lib/server-runtime/server'
import { chatView } from '@/lib/coordinator/store'
import * as chatStore from '@/lib/coordinator/store'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { openChatBotId } from '@/lib/coordinator/coordinator-bot'
import { coordinatorEnabled } from '@/lib/coordinator/wake'
import { defineRoute } from '@/lib/primitives/define-route'

/** `GET /api/coordinator/messages`: the person's conversation with their Coordinator, oldest first. */
export const GET = defineRoute<'session', 'pat-scoped'>(
  { route: '/api/coordinator/messages', auth: 'session', origin: 'any', workspace: 'pat-scoped', desktop: true },
  async ({ request, user }) => {
    const botId = await openChatBotId(user, null)
    const params = new URL(request.url).searchParams
    const cursor = z.object({ after: z.coerce.number().int().min(0).max(2147483647), cursor: z.coerce.number().int().min(0).max(2147483647), prefix: z.string().regex(/^[0-9a-f]{32}$/) })
      .safeParse({ after: params.get('after'), cursor: params.get('cursor'), prefix: params.get('prefix') })
    if (params.has('after') && !cursor.success) return RouteResponse.json({ error: 'validationGeneric' }, { status: 400 })
    const current = await chatStore.chatVersion(user.id, 200, botId)
    const enabled = await coordinatorEnabled(user.id, botId)
    const state = { ...current, working: enabled && current.working, enabled, botId }
    const etag = `"${createHash('sha256').update(JSON.stringify([user.id, botId, state])).digest('hex')}"`
    const headers = { 'Cache-Control': 'private, no-store', ETag: etag, Vary: 'Cookie, Authorization' }
    if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
    if (params.get('known') === current.version) return RouteResponse.json({ unchanged: true, ...state }, { headers })
    const chat = cursor.success ? await chatStore.chatUpdate(user.id, botId, cursor.data) : await chatView(user.id, 200, botId)
    return RouteResponse.json({ ...chat, ...state }, { headers })
  },
)

// Retirement is deliberately public and returns before parsing input.
export const POST = defineRoute<'public', 'none'>(
  { route: '/api/coordinator/messages', auth: 'public', origin: 'any', workspace: 'none', desktop: true },
  () => Response.json({ error: 'coordinatorSendRetired' }, { status: 410, headers: { 'Cache-Control': 'no-store' } }),
)
