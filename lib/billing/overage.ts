import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, pool } from '@/lib/db'
import { workspaceBilling } from '@/lib/db/schema'
import { MICRO_USD_PER_POINT } from '@/lib/abuse/policy'
import { WorkspaceError } from '@/lib/workspace-access'
import { recordAudit } from '@/lib/audit/write'
import { requireAccountOwner } from './authority'
import type { OveragePolicyView } from './contract'
import { overageInputSchema } from './overage-schema'

export type { OveragePolicyView } from './contract'
export { overageInputSchema, type OverageInput } from './overage-schema'

/** Reads confirmed current-UTC-month overage spend from purchased credits. */
export async function readMonthlyOverageMicroUsd(accountWorkspaceId: string): Promise<number> {
  const { rows } = await pool.query<{ spent: string }>(
    `SELECT COALESCE(sum("purchasedMicroUsd"), 0)::text AS spent
     FROM hosted_usage
     WHERE "workspaceId"=$1 AND state<>'failed' AND COALESCE("billingSource",'credits')='credits'
       AND "createdAt">=date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [accountWorkspaceId],
  )
  return Number(rows[0]?.spent ?? 0)
}

/** Projects the persisted overage settings and current-month spend into a client DTO. */
export function overagePolicy(
  row?: Pick<typeof workspaceBilling.$inferSelect, 'overageEnabled' | 'overageMonthlyCapPoints' | 'overageRevision'>,
  spentOverageMicroUsd = 0,
): OveragePolicyView {
  const enabled = row?.overageEnabled ?? false
  const monthlyCapPoints = row?.overageMonthlyCapPoints ?? null
  const spentOveragePoints = Math.ceil(Math.max(0, spentOverageMicroUsd) / MICRO_USD_PER_POINT)
  const remainingOveragePoints = monthlyCapPoints !== null ? Math.max(0, monthlyCapPoints - spentOveragePoints) : null
  return {
    enabled,
    monthlyCapPoints,
    spentOveragePoints,
    remainingOveragePoints,
    revision: row?.overageRevision ?? 0,
  }
}

/** Owner-only overage toggle and mandatory monthly cap (#3328). */
export async function saveOveragePolicy(actorId: string, accountWorkspaceId: string, raw: unknown): Promise<OveragePolicyView> {
  const value = overageInputSchema.parse(raw)
  z.uuid().parse(accountWorkspaceId)
  const actorName = await requireAccountOwner(actorId, accountWorkspaceId)
  if (value.enabled && (value.monthlyCapPoints === null || value.monthlyCapPoints <= 0)) {
    throw new WorkspaceError('billingOverageCapRequired')
  }
  const normalizedCap = value.monthlyCapPoints === 0 ? null : value.monthlyCapPoints
  if (value.enabled && normalizedCap === null) throw new WorkspaceError('billingOverageCapRequired')
  const saved = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${accountWorkspaceId}`},0))`)
    const [prior] = await tx.select().from(workspaceBilling).where(eq(workspaceBilling.workspaceId, accountWorkspaceId)).for('update').limit(1)
    if ((prior?.overageRevision ?? 0) !== value.expectedRevision) throw new WorkspaceError('billingPolicyChanged')
    if (value.expectedRevision >= 2_147_483_647) throw new WorkspaceError('billingPolicyChanged')
    const next = {
      overageEnabled: value.enabled,
      overageMonthlyCapPoints: normalizedCap,
      overageRevision: value.expectedRevision + 1,
      updatedAt: new Date(),
    }
    await tx.insert(workspaceBilling).values({ workspaceId: accountWorkspaceId, ...next })
      .onConflictDoUpdate({ target: workspaceBilling.workspaceId, set: next })
    await recordAudit(tx, {
      workspaceId: accountWorkspaceId,
      actor: { type: 'user', id: actorId, name: actorName },
      action: 'billing.overage_changed',
      metadata: {
        enabled: value.enabled,
        monthlyCapCents: normalizedCap,
        revision: next.overageRevision,
      },
    })
    return next
  })
  return overagePolicy(saved, await readMonthlyOverageMicroUsd(accountWorkspaceId))
}
