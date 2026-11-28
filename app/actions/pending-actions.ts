'use server'

import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { requireUser } from '@/lib/acting-user'

/**
 * Retired: nothing waits for a person's approval (ADR 2026-11-27-1615), so
 * there is nothing to approve or decline. Kept for one release only because the
 * official UI still imports it; it decides nothing and always answers
 * `pendingActionUnavailable`. Remove with the hosted follow-up.
 */
export async function decidePendingAction(_id: string, _approve: boolean): Promise<ActionResult<{ status: 'done' | 'failed' | 'declined' | 'running'; reason: string | null }>> {
  return runAction(async () => {
    await requireUser()
    throw new ActionFailureError('pendingActionUnavailable')
  })
}
