import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { workspaceBilling } from '@/lib/db/schema'
import { WorkspaceError } from '@/lib/workspace-access'
import { withAccountOwnerLock } from './authority'
import { recordAudit } from '@/lib/audit/write'

export type { AutoRechargePolicyView } from './contract'
import type { AutoRechargePolicyView } from './contract'

/**
 * Stripe Managed Payments currently supports Checkout/Payment Links, not raw
 * off-session PaymentIntents or out-of-period invoices. Keep the existing MoR
 * contract. A saved limit is never authorization to switch payment providers.
 * https://docs.stripe.com/payments/managed-payments#unsupported-integrations
 */
export function autoRechargePolicy(row?: Pick<typeof workspaceBilling.$inferSelect, 'autoRechargeThreshold' | 'autoRechargeAmountPoints' | 'autoRechargeMonthlyCap' | 'autoRechargeRevision'>): AutoRechargePolicyView {
  return { state: 'provider_unsupported', enabled: false, provider: 'stripe_managed_payments',
    thresholdPoints: row?.autoRechargeThreshold ?? null, amountPoints: row?.autoRechargeAmountPoints ?? null,
    monthlyCapPoints: row?.autoRechargeMonthlyCap ?? null, revision: row?.autoRechargeRevision ?? 0 }
}

import { autoRechargeInputSchema } from './auto-recharge-schema'
export { autoRechargeInputSchema, type AutoRechargeInput } from './auto-recharge-schema'

const input = autoRechargeInputSchema

/** Owner-only saved limits/revocation. Enabling an unsupported payment flow is refused before any provider I/O. */
export async function saveAutoRechargePolicy(actorId: string, accountWorkspaceId: string, raw: unknown) {
  const value = input.parse(raw)
  z.uuid().parse(accountWorkspaceId)
  return withAccountOwnerLock(actorId, accountWorkspaceId, async actorName => {
    if (value.enabled) throw new WorkspaceError('billingAutoRechargeUnavailable')
    return db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${accountWorkspaceId}`},0))`)
      const [prior] = await tx.select().from(workspaceBilling).where(eq(workspaceBilling.workspaceId, accountWorkspaceId)).for('update').limit(1)
      if ((prior?.autoRechargeRevision ?? 0) !== value.expectedRevision) throw new WorkspaceError('billingPolicyChanged')
      if (value.expectedRevision >= 2_147_483_647) throw new WorkspaceError('billingPolicyChanged')
      const saved = { autoRechargeEnabled: false, autoRechargeThreshold: value.thresholdPoints,
        autoRechargeAmountPoints: value.amountPoints, autoRechargeMonthlyCap: value.monthlyCapPoints,
        autoRechargeConsentBy: null, autoRechargeConsentAt: null, autoRechargeRevision: value.expectedRevision + 1, updatedAt: new Date() }
      await tx.insert(workspaceBilling).values({ workspaceId: accountWorkspaceId, ...saved })
        .onConflictDoUpdate({ target: workspaceBilling.workspaceId, set: saved })
      await recordAudit(tx, { workspaceId: accountWorkspaceId, actor: { type: 'user', id: actorId, name: actorName },
        action: 'billing.auto_recharge_changed', metadata: { enabled: false, thresholdCents: value.thresholdPoints,
          amountCents: value.amountPoints, monthlyCapCents: value.monthlyCapPoints, revision: saved.autoRechargeRevision } })
      return autoRechargePolicy(saved)
    })
  })
}
