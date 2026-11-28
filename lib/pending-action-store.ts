import 'server-only'
import { eq } from 'drizzle-orm'
import { isApprovalAction, parseActionInput } from '@/lib/composio-actions'
import { runComposioAction } from '@/lib/composio'
import { db } from '@/lib/db'
import { pendingActions } from '@/lib/db/schema'
import { actionOutcome } from '@/lib/pending-action-view'
import type { NativeWriteReview } from './operations/native-write-review'

/**
 * Sends mail or writes the calendar in the person's connected account.
 *
 * Every call runs directly in the account the person authorized: there is no
 * approval card (ADR 2026-11-27-1615). A supplied native review still checks the
 * exact prepared input, account and tool version before dispatch, and can only
 * stop the call.
 *
 * The `pending_actions` row is the write receipt: written as `running` before
 * dispatch, then `done` or `failed`. An `operationUncertain` result stays
 * `running`, so nothing ever resends it.
 */
export async function writeAccountAction(userId: string, action: string, input: unknown, selectedAccountId?: string, botId: string | null = null, review?: NativeWriteReview, signal?:AbortSignal) {
  if (!isApprovalAction(action)) return { error: 'integrationActionNotAllowed' }
  const parsed = parseActionInput(action, input)
  if (!parsed) return { error: 'invalidIntegrationInput' }
  const id = crypto.randomUUID()
  let recorded = false as boolean
  const result = await runComposioAction(userId, action, parsed, selectedAccountId, async (accountId, tool) => {
    const decision = review ? await review('allow', { ownerId: userId, botId, action, input: parsed, accountId, version: tool.version ?? '', policy: null }) : 'allow'
    if (decision !== 'allow') return { error: 'integrationActionDenied' }
    await db.insert(pendingActions).values({ id, userId, botId, action, input: parsed, connectedAccountId: accountId, status: 'running' })
    recorded = true
    return null
  }, signal)
  // The gate runs before every dispatch, so an unrecorded result never sent anything.
  if (!recorded) return 'error' in result ? result : { error: 'integrationActionFailed' }
  if ('error' in result) {
    // operationUncertain stays running: it may have been sent, so never invite a resend.
    await db.update(pendingActions).set({ status: result.error === 'operationUncertain' ? 'running' : 'failed', error: result.error }).where(eq(pendingActions.id, id))
    return result
  }
  const outcome = actionOutcome(result.data)
  await db.update(pendingActions).set({ status: 'done', result: outcome }).where(eq(pendingActions.id, id))
  return { status: 'done' as const, actionId: id, outcome }
}
