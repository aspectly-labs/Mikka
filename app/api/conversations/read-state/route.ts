import { z } from 'zod'
import { forbiddenOrigin, json, writeAllowed } from '@/lib/mobile-api'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'
import { changeThreadRead, threadReadReceipts, type ThreadReadChange } from '@/lib/thread-reads'
import { defineRoute } from '@/lib/primitives/define-route'

const change = z.union([
  z.strictObject({ action: z.literal('unread'), runId: z.uuid() }),
  z.strictObject({ action: z.literal('unread'), chatId: z.uuid() }),
  z.strictObject({ action: z.literal('read'), chatId: z.uuid() }),
  // 标为已读 from a list row: up to the run's activity right now, read here rather than sent by the client.
  z.strictObject({ action: z.literal('readLatest'), runId: z.uuid() }),
  z.object({ action: z.literal('read'), runId: z.uuid(), through: z.iso.datetime().nullable(), revision: z.number().int().nonnegative() }),
  z.object({ action: z.literal('readAll') }),
])

export const POST = defineRoute<'mobile-or-session', 'pat-scoped'>(
  { auth: 'mobile-or-session', origin: 'native-mobile-allowed', workspace: 'pat-scoped', write: true, desktop: true },
  async ({ request, user }) => {
    if (!writeAllowed(request)) return forbiddenOrigin()
    const parsed = change.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return json({ error: 'invalidInput' }, 422)
    const workspaceId = await effectiveRequestWorkspace(user)
    if (!workspaceId) return json({ error: 'conversationNotFound' }, 404)
    let read: ThreadReadChange
    if (parsed.data.action === 'readLatest') {
      const [receipt] = await threadReadReceipts(user.id, [parsed.data.runId])
      if (!receipt) return json({ error: 'conversationNotFound' }, 404)
      read = { action: 'read', runId: receipt.id, through: receipt.through, revision: receipt.revision }
    } else read = parsed.data
    if (!await changeThreadRead(user, workspaceId, read)) return json({ error: 'conversationNotFound' }, 404)
    return json({ ok: true })
  },
)
