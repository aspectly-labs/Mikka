'use server'

import type { ActionResult } from '@/lib/action-result'
import type { TurnUsage } from '@/lib/turn-usage'
import type { UsageTurnRef } from '@/lib/usage-turn-ref'
import { currentMonth, usageMonth } from '@/lib/usage/month'
import { workspaceUsage, type WorkspaceUsage } from '@/lib/usage/read'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'

/** 设置 › 用量 for one month (YYYY-MM, UTC). Admins see the workspace; members their own bots. */
export async function getUsage(month?: string, workspaceId?: string): Promise<ActionResult<WorkspaceUsage>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return workspaceUsage(actor.userId, actor.workspaceId, usageMonth.parse(month ?? currentMonth()))
  })
}

/**
 * The model calls behind conversation turns, for the line under a reply (#2934 item 5, #2922): model, tokens and cost
 * per turn reference (lib/usage-turn-ref.ts). The reader sees only calls they made or that ran for them.
 */
export async function readTurnUsage(refs: string[], workspaceId?: string): Promise<ActionResult<Record<UsageTurnRef, TurnUsage>>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    const [{ pool }, { readTurnUsage: read }] = await Promise.all([import('@/lib/db'), import('@/lib/turn-usage')])
    return read(pool, { readerId: actor.userId, workspaceId: actor.workspaceId, refs })
  })
}
