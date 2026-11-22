'use server'

import type { ActionResult } from '@/lib/action-result'
import { ActionFailureError } from '@/lib/action-error'
import { GovernanceError } from '@/lib/governance/errors'
import { requireUser } from '@/lib/issue-access'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { readWorkspaceOpsMetrics } from '@/lib/settings/ops-metrics'
import type { WorkspaceOpsMetricsView } from '@/lib/settings/device-policy-contract'

/** 设置 › 云与运行监控 (Frame 30). Workspace admins only. */
export async function getWorkspaceOpsMetrics(workspaceId?: string): Promise<ActionResult<WorkspaceOpsMetricsView>> {
  return workspaceAction(async () => {
    const [user, actor] = await Promise.all([requireUser(), currentWorkspaceActor(workspaceId)])
    try {
      return await readWorkspaceOpsMetrics(user, actor.workspaceId)
    } catch (error) {
      if (error instanceof GovernanceError) {
        throw new ActionFailureError(
          error.detail === 'access_denied' ? 'workspaceAccessDenied' : 'validationGeneric',
          undefined,
          undefined,
          { cause: error },
        )
      }
      throw error
    }
  })
}
