'use server'

import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { requireUser } from '@/lib/acting-user'
import { pool } from '@/lib/db'
import { listApprovalRules as listForOwner, revokeApprovalRule as revokeForOwner, type ApprovalRuleView } from '@/lib/operations/approval-rule-store'

/**
 * The signed-in person's remembered approvals (「始终同意」), newest first: what
 * 设置 › 权限 lists, as Claude Code's `/permissions` does. Only their own rows.
 */
export async function listApprovalRules(): Promise<ActionResult<ApprovalRuleView[]>> {
  return runAction(async () => listForOwner(pool, (await requireUser()).id))
}

/** Forgets one remembered approval; the next matching action asks again. */
export async function revokeApprovalRule(id: string): Promise<ActionResult<{ revoked: true }>> {
  return runAction(async () => {
    const userId = (await requireUser()).id
    const parsed = z.uuid().safeParse(id)
    if (!parsed.success || !await revokeForOwner(pool, userId, parsed.data)) throw new ActionFailureError('approvalRuleUnavailable')
    return { revoked: true as const }
  })
}
