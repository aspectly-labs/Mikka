import type { createApprovedWrites } from './approved-writes'
import { WRITE_ACTIONS, type WriteActionName } from './write-contract'
import { OperationError } from './ledger'
import { z } from 'zod'
import { MailboxError } from '@/lib/mailbox-error'
import type { WriteRequestContext } from './write-transaction'
import { discoveryInput, type createApprovedWriteDiscovery } from './write-discovery'
import { humanSessionHeaders } from '@/lib/desktop-rpc/handler'

// Reads only: a person no longer proposes or approves a write here (ADR
// 2026-11-27-1615). `decide` still parses for one release, because the official
// UI still sends it, and is always answered `pendingActionUnavailable`.
const requestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('decide'), action: z.enum(WRITE_ACTIONS), id: z.uuid(), approve: z.boolean() }).strict(),
  z.object({ op: z.literal('view'), action: z.enum(WRITE_ACTIONS), id: z.uuid() }).strict(),
  discoveryInput.extend({ op: z.literal('list') }).strict(),
])
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
/** Route factory only; product owner chooses URL/registration. No worker tokens.
 * Bind auth to the real Better Auth instance; never construct actor from JSON. */
export function approvedWriteHandler(auth: { api: { getSession: (args: { headers: Headers; query: { disableCookieCache: boolean } }) => Promise<{ user: { id: string }; session: { id: string } } | null> } }, operations: (action: WriteActionName, context?: WriteRequestContext) => Pick<ReturnType<typeof createApprovedWrites>, 'view'>, discovery?: ReturnType<typeof createApprovedWriteDiscovery>) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return new Response(null, { status: 405 })
    const sessionHeaders = humanSessionHeaders(request)
    if (!sessionHeaders) return new Response(null, { status: 401 })
    if (request.headers.get('origin') !== new URL(request.url).origin) return new Response(null, { status: 403 })
    try {
      const session = await auth.api.getSession({ headers: sessionHeaders, query: { disableCookieCache: true } })
      if (!session) return new Response(null, { status: 401 })
      let raw: unknown
      try { raw = await request.json() }
      catch { return json({ error: 'invalidWriteRequest' }, 400) }
      const parsed = requestSchema.safeParse(raw)
      if (!parsed.success) return json({ error: 'invalidWriteRequest' }, 400)
      const body = parsed.data
      if (body.op === 'list') {
        if (!discovery) return json({ error: 'approvedWriteDiscoveryUnavailable' }, 503)
        return json({ ...await discovery.list({ userId: session.user.id, sessionId: session.session.id }, { cursor: body.cursor, limit: body.limit, unresolvedOnly: body.unresolvedOnly }, { signal: request.signal }), viewerId: session.user.id, observedAt: new Date().toISOString() })
      }
      if (body.op === 'decide') return json({ error: 'pendingActionUnavailable' }, 409)
      const service = operations(body.action, { signal: request.signal, actor: { userId: session.user.id, sessionId: session.session.id } })
      const result = await service.view({ userId: session.user.id, sessionId: session.session.id }, body.id)
      return json({ ...result, observedAt: new Date().toISOString() })
    } catch (error) {
      if (error instanceof MailboxError) return json({ error: error.commitState === 'unconfirmed' ? 'writeCommitUnconfirmed' : error.commitState === 'committed' ? 'writeCommitFinalizationFailed' : error.message === 'writeTransactionCleanupUncertain' ? 'writeTransactionCleanupUncertain' : 'writeTransactionCancelled', ...(error.commitState ? { commitState: error.commitState } : {}) }, error.status)
      if (error instanceof OperationError) return json({ error: error.message }, 409)
      // A transport/service failure is not evidence that an approved effect failed.
      // Clients must retain the same intent/action ID when checking the outcome.
      return json({ error: 'writeServiceUnavailable' }, 503)
    }
  }
}
