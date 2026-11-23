import 'server-only'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { workspaceBilling } from '@/lib/db/schema'
import { organizationBillingAccounts, organizationMembers } from '@/lib/db/governance-schema'
import { workspaces } from '@/lib/db/workspace-schema'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import type { EnterprisePrincipal } from '@/lib/enterprise/principal'
import { autoRechargePolicy, saveAutoRechargePolicy } from './auto-recharge'
import type { BillingReceiptsPolicyView, WorkspaceBillingSettingsView } from './contract'

/**
 * Financial receipts and billing emails are owned exclusively by Stripe Customer
 * Portal / Stripe Managed Payments (MoR). `billing_refund_receipts`
 * (`drizzle/20261110150012_billing_financial_receipts.sql`) is a webhook refund
 * reconciliation inbox, never an outbound email mailer or user toggle.
 */
export const BILLING_RECEIPTS_POLICY: BillingReceiptsPolicyView = {
  receiptsManagedBy: 'stripe_portal',
  source: 'provider',
}

async function resolveWorkspaceBillingSettingsAuthority(
  actorId: string,
  workspaceId: string,
  principal?: EnterprisePrincipal,
) {
  z.uuid().parse(workspaceId)
  return workspaceDb.transaction(async tx => {
    await requireWorkspace(tx, workspaceId, actorId, true, principal)
    const [workspace] = await tx
      .select({ id: workspaces.id, ownerId: workspaces.userId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
    if (!workspace) throw new WorkspaceError('workspaceAccessDenied')
    const [orgPayer] = await tx
      .select({
        organizationId: organizationBillingAccounts.organizationId,
        accountWorkspaceId: organizationBillingAccounts.workspaceId,
      })
      .from(organizationBillingAccounts)
      .where(eq(organizationBillingAccounts.workspaceId, workspaceId))
      .limit(1)
    if (orgPayer) {
      const [orgOwner] = principal?.kind === 'pat'
        ? []
        : await tx
            .select({ userId: organizationMembers.userId })
            .from(organizationMembers)
            .where(and(
              eq(organizationMembers.organizationId, orgPayer.organizationId),
              eq(organizationMembers.userId, actorId),
              eq(organizationMembers.status, 'active'),
              eq(organizationMembers.role, 'owner'),
            ))
            .limit(1)
      return {
        accountWorkspaceId: orgPayer.accountWorkspaceId,
        canManageRecharge: Boolean(orgOwner),
      }
    }
    return {
      accountWorkspaceId: workspace.id,
      canManageRecharge: principal?.kind !== 'pat' && workspace.ownerId === actorId,
    }
  })
}

export async function readWorkspaceBillingSettings(
  actorId: string,
  workspaceId: string,
  principal?: EnterprisePrincipal,
): Promise<WorkspaceBillingSettingsView> {
  const { accountWorkspaceId, canManageRecharge } = await resolveWorkspaceBillingSettingsAuthority(
    actorId,
    workspaceId,
    principal,
  )
  const [billing] = await db
    .select()
    .from(workspaceBilling)
    .where(eq(workspaceBilling.workspaceId, accountWorkspaceId))
    .limit(1)
  return {
    workspaceId,
    accountWorkspaceId,
    canManageRecharge,
    receiptsManagedBy: BILLING_RECEIPTS_POLICY.receiptsManagedBy,
    source: BILLING_RECEIPTS_POLICY.source,
    receipts: BILLING_RECEIPTS_POLICY,
    autoRecharge: autoRechargePolicy(billing),
  }
}

export async function writeWorkspaceAutoRecharge(
  actorId: string,
  workspaceId: string,
  rawPolicy: unknown,
  principal?: EnterprisePrincipal,
): Promise<WorkspaceBillingSettingsView> {
  const { accountWorkspaceId, canManageRecharge } = await resolveWorkspaceBillingSettingsAuthority(
    actorId,
    workspaceId,
    principal,
  )
  if (!canManageRecharge) throw new WorkspaceError('workspaceAccessDenied')
  const saved = await saveAutoRechargePolicy(actorId, accountWorkspaceId, rawPolicy)
  return {
    workspaceId,
    accountWorkspaceId,
    canManageRecharge,
    receiptsManagedBy: BILLING_RECEIPTS_POLICY.receiptsManagedBy,
    source: BILLING_RECEIPTS_POLICY.source,
    receipts: BILLING_RECEIPTS_POLICY,
    autoRecharge: saved,
  }
}
