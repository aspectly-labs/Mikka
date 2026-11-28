import 'server-only'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { workspaceBilling } from '@/lib/db/schema'
import { organizationBillingAccounts, organizationMembers, organizations } from '@/lib/db/governance-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { workspaceDb } from '@/lib/workspace-db'
import { recordAudit } from '@/lib/audit/write'
import { runtimeEnv, type EnvMap } from '@/lib/env/server'
import { resolvePlatformBillingAccount } from './organization-account'
import { resourcePrice, RESOURCE_BILLING_VERSION } from './resource-plan'
import { configuredResourcePriceIds, stripeConfig, stripeGet, stripePost, StripeRequestError } from './stripe'

const stripeId = z.string().regex(/^[a-z]+_[A-Za-z0-9_]+$/)
const subscriptionItemSchema = z.object({
  id: stripeId,
  quantity: z.number().int().nonnegative().optional(),
  price: z.object({ id: stripeId }).loose(),
}).loose()
const liveSubscriptionSchema = z.object({
  id: stripeId,
  status: z.string(),
  metadata: z.object({
    workspaceId: z.uuid(),
    billingModel: z.string().optional(),
  }).loose(),
  items: z.object({
    data: z.array(subscriptionItemSchema),
  }).loose(),
}).loose()

export interface BillingAccountSeatCount {
  readonly scope: 'organization' | 'workspace'
  readonly organizationId: string | null
  readonly activeMembers: number
  /** Stripe subscription quantity is always at least 1 active seat. */
  readonly seats: number
}

/**
 * Computes the canonical active human seat count for a platform billing account.
 * When the workspace is designated as an Organization's billing account, seats
 * count active Organization members across the Organization; otherwise seats
 * count active members of the workspace itself.
 */
export async function activeSeatCountForBillingAccount(accountWorkspaceId: string): Promise<BillingAccountSeatCount> {
  const [designation] = await workspaceDb
    .select({ organizationId: organizationBillingAccounts.organizationId })
    .from(organizationBillingAccounts)
    .innerJoin(organizations, eq(organizations.id, organizationBillingAccounts.organizationId))
    .where(and(eq(organizationBillingAccounts.workspaceId, accountWorkspaceId), isNull(organizations.archivedAt)))
    .limit(1)
  if (designation) {
    const [row] = await workspaceDb
      .select({ count: sql<number>`count(*)::int` })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, designation.organizationId), eq(organizationMembers.status, 'active')))
    const activeMembers = row?.count ?? 0
    return { scope: 'organization', organizationId: designation.organizationId, activeMembers, seats: Math.max(1, activeMembers) }
  }
  const [row] = await workspaceDb
    .select({ count: sql<number>`count(*)::int` })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, accountWorkspaceId), eq(workspaceMembers.status, 'active')))
  const activeMembers = row?.count ?? 0
  return { scope: 'workspace', organizationId: null, activeMembers, seats: Math.max(1, activeMembers) }
}

export type SeatSyncResult =
  | { readonly synced: true; readonly previousSeats: number; readonly seats: number; readonly prorationBehavior: 'always_invoice' | 'create_prorations' }
  | { readonly synced: false; readonly reason: 'unconfigured' | 'not_resource_subscription' | 'inactive_subscription' | 'unconfigured_price' | 'not_per_seat' | 'unchanged' | 'invalid_subscription'; readonly seats?: number }

export interface SyncSeatsOptions {
  env?: EnvMap
  fetchImpl?: typeof fetch
}

/**
 * Synchronizes a live `per_seat` resource_v1 Stripe subscription's quantity to
 * match the billing account's canonical active human seat count.
 *
 * Strictly executes Stripe network calls outside any database transaction:
 * - Seat increases use `always_invoice` so Stripe immediately bills the
 *   prorated seat delta and triggers `subscription_update` prorated credit
 *   grants in `subscription-webhook.ts`.
 * - Seat decreases use `create_prorations` so Stripe credits the next invoice
 *   without clawing back already-granted current-period credits.
 * - `per_workspace` plans and non-active subscriptions are clean no-ops.
 */
export async function syncPerSeatSubscriptionQuantity(
  billingAccountWorkspaceId: string,
  options: SyncSeatsOptions = {},
): Promise<SeatSyncResult> {
  const config = stripeConfig(options.env ?? runtimeEnv())
  if (!config) return { synced: false, reason: 'unconfigured' }
  const allowedPriceIds = configuredResourcePriceIds(config)
  if (!allowedPriceIds.length) return { synced: false, reason: 'unconfigured_price' }

  const [billing] = await db
    .select({
      stripeSubscriptionId: workspaceBilling.stripeSubscriptionId,
      stripePriceId: workspaceBilling.stripePriceId,
      billingModel: workspaceBilling.billingModel,
      status: workspaceBilling.status,
      seats: workspaceBilling.seats,
    })
    .from(workspaceBilling)
    .where(eq(workspaceBilling.workspaceId, billingAccountWorkspaceId))
    .limit(1)

  if (!billing?.stripeSubscriptionId || billing.billingModel !== RESOURCE_BILLING_VERSION || !billing.stripePriceId) {
    return { synced: false, reason: 'not_resource_subscription' }
  }
  if (billing.status !== 'active') {
    return { synced: false, reason: 'inactive_subscription' }
  }
  if (!allowedPriceIds.includes(billing.stripePriceId)) {
    return { synced: false, reason: 'unconfigured_price' }
  }

  const desired = await activeSeatCountForBillingAccount(billingAccountWorkspaceId)
  const fetchImpl = options.fetchImpl ?? fetch
  const rawSub = await stripeGet<unknown>(config, `subscriptions/${encodeURIComponent(billing.stripeSubscriptionId)}`, fetchImpl)
  const parsedSub = liveSubscriptionSchema.safeParse(rawSub)
  if (!parsedSub.success) return { synced: false, reason: 'invalid_subscription' }
  const sub = parsedSub.data
  if (
    sub.id !== billing.stripeSubscriptionId
    || sub.status !== 'active'
    || sub.metadata.workspaceId !== billingAccountWorkspaceId
    || sub.metadata.billingModel !== RESOURCE_BILLING_VERSION
    || sub.items.data.length !== 1
  ) {
    return { synced: false, reason: 'invalid_subscription' }
  }

  const item = sub.items.data[0]
  if (!allowedPriceIds.includes(item.price.id)) {
    return { synced: false, reason: 'unconfigured_price' }
  }
  const rawPrice = await stripeGet<unknown>(config, `prices/${encodeURIComponent(item.price.id)}`, fetchImpl)
  const approved = resourcePrice(rawPrice, item.price.id, { requireActive: false })
  if (approved.seatModel !== 'per_seat') {
    return { synced: false, reason: 'not_per_seat' }
  }

  const currentSeats = item.quantity ?? 1
  if (currentSeats === desired.seats) {
    if (billing.seats !== desired.seats) {
      await db.update(workspaceBilling)
        .set({ seats: desired.seats, updatedAt: new Date() })
        .where(and(
          eq(workspaceBilling.workspaceId, billingAccountWorkspaceId),
          eq(workspaceBilling.stripeSubscriptionId, sub.id),
        ))
    }
    return { synced: false, reason: 'unchanged', seats: desired.seats }
  }

  const prorationBehavior = desired.seats > currentSeats ? 'always_invoice' : 'create_prorations'
  await stripePost<unknown>(
    config,
    `subscription_items/${encodeURIComponent(item.id)}`,
    { quantity: desired.seats, proration_behavior: prorationBehavior },
    fetchImpl,
  )

  await db.transaction(async tx => {
    await tx.update(workspaceBilling)
      .set({ seats: desired.seats, updatedAt: new Date() })
      .where(and(
        eq(workspaceBilling.workspaceId, billingAccountWorkspaceId),
        eq(workspaceBilling.stripeSubscriptionId, sub.id),
      ))
    await recordAudit(tx, {
      workspaceId: billingAccountWorkspaceId,
      actor: { type: 'system', name: 'Billing seat sync' },
      action: 'billing.seats_synced',
      target: { type: 'billing_subscription', id: sub.id },
      metadata: { previousSeats: currentSeats, seats: desired.seats, prorationBehavior },
    })
  })

  return { synced: true, previousSeats: currentSeats, seats: desired.seats, prorationBehavior }
}

/**
 * Best-effort post-commit seat sync for a workspace membership change.
 * Resolves Organization billing account designation automatically and never
 * throws into the enclosing membership mutation when Stripe is unavailable.
 */
export async function syncPerSeatSubscriptionForWorkspace(
  workspaceId: string,
  options: SyncSeatsOptions = {},
): Promise<void> {
  if (!stripeConfig(options.env ?? runtimeEnv())) return
  try {
    const account = await resolvePlatformBillingAccount(workspaceId)
    await syncPerSeatSubscriptionQuantity(account.accountWorkspaceId, options)
  } catch (error) {
    console.error('[billing] per-seat subscription sync failed', {
      name: error instanceof Error ? error.name : 'UnknownError',
      status: error instanceof StripeRequestError ? error.status : null,
    })
  }
}

/**
 * Best-effort post-commit seat sync for an Organization membership change.
 * No-ops when the Organization has no designated billing account, and never
 * throws into the enclosing membership mutation when Stripe is unavailable.
 */
export async function syncPerSeatSubscriptionForOrganization(
  organizationId: string,
  options: SyncSeatsOptions = {},
): Promise<void> {
  if (!stripeConfig(options.env ?? runtimeEnv())) return
  try {
    const [account] = await workspaceDb
      .select({ workspaceId: organizationBillingAccounts.workspaceId })
      .from(organizationBillingAccounts)
      .innerJoin(organizations, eq(organizations.id, organizationBillingAccounts.organizationId))
      .where(and(eq(organizationBillingAccounts.organizationId, organizationId), isNull(organizations.archivedAt)))
      .limit(1)
    if (!account) return
    await syncPerSeatSubscriptionQuantity(account.workspaceId, options)
  } catch (error) {
    console.error('[billing] organization per-seat subscription sync failed', {
      name: error instanceof Error ? error.name : 'UnknownError',
      status: error instanceof StripeRequestError ? error.status : null,
    })
  }
}
