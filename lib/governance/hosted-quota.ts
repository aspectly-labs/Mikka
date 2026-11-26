import 'server-only'
import type { Pool, PoolClient } from 'pg'
import type { HostedQuotaLease } from '@/lib/abuse/store'
import { deploymentMode } from './edition'
import { resolveEntitlements, resolvePlanFromGrants, type DeploymentMode, type Plan, type PlanGrant } from './policy'
import { GovernanceError } from './errors'
import { hostedBillingScope } from '@/lib/abuse/context'
import { PaidResourceError } from '@/lib/abuse/policy'

/** Product quota only. This function cannot authenticate a caller or authorize a model call. */
export async function acquireHostedQuota(workspaceId: string, database?: Pick<Pool, 'connect'>, mode: DeploymentMode = deploymentMode()): Promise<HostedQuotaLease & { plan: Plan; cloudMachinePlan: Plan }> {
  const workspace = database ? undefined : await import('@/lib/workspace-db')
  const target = database ?? workspace!.workspacePool
  // Cloud task admission pins Workspace policy across provider startup. Borrow
  // its executor instead of waiting for another connection in the same pool.
  const client: PoolClient | null = workspace?.workspaceTransactionKey?.() ? null : await target.connect()
  const query = client ?? workspace!.workspacePool
  let closed = false
  const close = async () => {
    if (closed || !client) return
    closed = true
    try { await client.query('ROLLBACK'); client.release() }
    catch (error) { client.release(error instanceof Error ? error : new Error('governance_quota_cleanup', { cause: error })); throw error }
  }
  try {
    if (client) {
      await client.query('BEGIN')
      await client.query("set local lock_timeout='5s'; set local statement_timeout='5s'; set local idle_in_transaction_session_timeout='30s'")
    }
    const { rows: [workspace] } = await query.query<{ kind: 'personal' | 'team' }>('select kind from mikka_workspaces where id=$1 for share', [workspaceId])
    if (!workspace) throw new GovernanceError('not_found')
    const { rows: [link] } = await query.query<{ organizationId: string }>('select "organizationId" from mikka_organization_workspaces where "workspaceId"=$1', [workspaceId])
    if (link) await query.query('select id from mikka_organizations where id=$1 for share', [link.organizationId])
    const { rows: [account] } = await query.query<{ workspaceId: string }>('select "workspaceId" from mikka_organization_billing_accounts where "organizationId"=$1', [link?.organizationId ?? null])
    const shareOwner = hostedBillingScope.getStore()?.creditShareOwnerId
    if (shareOwner) {
      const active = await query.query('select 1 from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2 and status=\'active\'', [workspaceId, shareOwner])
      if (!active.rows.length) throw new PaidResourceError('billing_authorization_revoked')
    }
    const organizationId = workspace.kind === 'team' ? link?.organizationId ?? null : null
    const { rows: grants } = await query.query<PlanGrant>(`select plan,source,"seatLimit","expiresAt","billingPlan","billingExpiresAt" from mikka_workspace_entitlements where "workspaceId"=$1
      union all select plan,source,"seatLimit","expiresAt","billingPlan","billingExpiresAt" from mikka_organization_entitlements where "organizationId"=$2`, [workspaceId, organizationId])
    const entitlements = resolveEntitlements({ mode, kind: workspace.kind, grants })
    const cloudMachinePlan = resolvePlanFromGrants({ mode, grants })
    return { limit: entitlements.hostedMaxInFlight, plan: entitlements.plan, cloudMachinePlan, close,
      billingAccount: { workspaceId: account?.workspaceId ?? workspaceId, organizationId: account ? link!.organizationId : null } }
  } catch (error) { await close(); throw error }
}
