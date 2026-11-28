import { z } from 'zod'
import { botBody, botRoute } from '@/lib/bot-route'
import { defineRoute } from '@/lib/primitives/define-route'

/** The owner hands the Bot to another active member of the workspace. */
export const POST = defineRoute<'session', 'pat-scoped', { botId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    write: true,
  },
  ({ request, params }) => botRoute(request, Promise.resolve(params), async ({ userId, workspaceId, botId }) => {
    const { ownerId } = await botBody(request, z.object({ ownerId: z.string().min(1).max(128) }).strict())
    return (await import('@/lib/bot-access')).transferBotOwnership({ userId, workspaceId }, botId, ownerId)
  }),
)
