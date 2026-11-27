'use server'

import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { requireUser } from '@/lib/acting-user'
import { decidePendingAction as decideForUser } from '@/lib/pending-actions'

const getUserId = async () => (await requireUser()).id

const options = z.object({ remember: z.boolean().optional(), note: z.string().max(4000).optional() }).strict().optional()

/**
 * Approves (runs) or declines one proposal. Both options are optional, so older
 * callers keep working (decision 2026-11-27-1500-remembered-approvals):
 * `remember` with an approval is 「始终同意」: the server derives the rule from
 * the stored card and reports whether it kept one (`remembered`); `note` is the
 * person's words, which reach the Agent with the outcome (on a decline, what to
 * do instead).
 */
export async function decidePendingAction(id: string, approve: boolean, decision?: { remember?: boolean; note?: string }): Promise<ActionResult<{ status: 'done' | 'failed' | 'declined' | 'running'; reason: string | null; remembered: boolean }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const parsed = z.uuid().safeParse(id)
    const extra = options.safeParse(decision)
    if (!parsed.success || !extra.success) throw new ActionFailureError('pendingActionUnavailable')
    const { status, error, remembered } = await decideForUser(userId, parsed.data, approve === true, extra.data ?? {})
    return { status, reason: error, remembered }
  })
}
