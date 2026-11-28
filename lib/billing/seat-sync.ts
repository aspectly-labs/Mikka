import 'server-only'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { workspaceBilling } from '@/lib/db/schema'
import { organizationBillingAccounts, organizationMembers, organizations, organizationWorkspaces } from '@/lib/db/governance-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { workspaceDb, workspaceTransactionKey } from '@/lib/workspace-db'
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
 * When the workspace is designated as a non-archived Organization's billing
 * account, seats count the distinct union of active Organization members and
 * active members of all attached Workspaces; otherwise seats count active
 * members of the workspace itself.
 */
export async function activeSeatCountForBillingAccount(accountWorkspaceId: string): Promise<BillingAccountSeatCount> {
  const [designation] = await workspaceDb
    .select({ organizationId: organizationBillingAccounts.organizationId })
    .from(organizationBillingAccounts)
    .innerJoin(organizations, eq(organizations.id, organizationBillingAccounts.organizationId))
    .where(and(eq(organizationBillingAccounts.workspaceId, accountWorkspaceId), isNull(organizations.archivedAt)))
    .limit(1)
  if (designation) {
    const result = await workspaceDb.execute(sql`
      SELECT count(*)::int AS count FROM (
        SELECT ${organizationMembers.userId} AS "userId"
        FROM ${organizationMembers}
        WHERE ${organizationMembers.organizationId} = ${designation.organizationId}
          AND ${organizationMembers.status} = 'active'
        UNION
        SELECT ${workspaceMembers.userId} AS "userId"
        FROM ${workspaceMembers}
        INNER JOIN ${organizationWorkspaces}
          ON ${organizationWorkspaces.workspaceId} = ${workspaceMembers.workspaceId}
        WHERE ${organizationWorkspaces.organizationId} = ${designation.organizationId}
          AND ${workspaceMembers.status} = 'active'
      ) active_org_seats
    `)
    const activeMembers = Number((result.rows[0] as { count?: number } | undefined)?.count ?? 0)
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

export interface SyncOrganizationSeatsOptions extends SyncSeatsOptions {
  /** Attached workspaces whose local memberships changed (synced if the Org has no designated billing account). */
  affectedWorkspaceIds?: readonly string[]
}

/** Per-account in-process queue so overlapping seat changes serialize without holding DB locks across Stripe I/O. */
const inFlightByAccount = new Map<string, Promise<unknown>>()

async function serializeAccountSync<T>(accountWorkspaceId: string, work: () => Promise<T>): Promise<T> {
  const prior = inFlightByAccount.get(accountWorkspaceId) ?? Promise.resolve()
  const run = prior.catch(() => undefined).then(work)
  const settled = run.then(() => undefined, () => undefined)
  inFlightByAccount.set(accountWorkspaceId, settled)
  try {
    return await run
  } finally {
    if (inFlightByAccount.get(accountWorkspaceId) === settled) {
      inFlightByAccount.delete(accountWorkspaceId)
    }
  }
}

async function persistSeatsFenced(input: {
  billingAccountWorkspaceId: string
  subscriptionId: string
  priceId: string
  expectedRevision: number
  previousSeats: number
  seats: number
  prorationBehavior: 'always_invoice' | 'create_prorations' | null
}): Promise<boolean> {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${input.billingAccountWorkspaceId}`},0))`)
    const updated = await tx.update(workspaceBilling)
      .set({ seats: input.seats, updatedAt: new Date() })
      .where(and(
        eq(workspaceBilling.workspaceId, input.billingAccountWorkspaceId),
        eq(workspaceBilling.stripeSubscriptionId, input.subscriptionId),
        eq(workspaceBilling.status, 'active'),
        eq(workspaceBilling.stripePriceId, input.priceId),
        eq(workspaceBilling.billingRevision, input.expectedRevision),
      ))
      .returning({ workspaceId: workspaceBilling.workspaceId })
    if (!updated.length) return false
    if (input.prorationBehavior) {
      await recordAudit(tx, {
        workspaceId: input.billingAccountWorkspaceId,
        actor: { type: 'system', name: 'Billing seat sync' },
        action: 'billing.seats_synced',
        target: { type: 'billing_subscription', id: input.subscriptionId },
        metadata: { previousSeats: input.previousSeats, seats: input.seats, prorationBehavior: input.prorationBehavior },
      })
    }
    return true
  })
}

async function runSeatSync(
  billingAccountWorkspaceId: string,
  options: SyncSeatsOptions,
): Promise<SeatSyncResult> {
  const config = stripeConfig(options.env ?? runtimeEnv())
  if (!config) return { synced: false, reason: 'unconfigured' }
  const allowedPriceIds = configuredResourcePriceIds(config)
  if (!allowedPriceIds.length) return { synced: false, reason: 'unconfigured_price' }
  const fetchImpl = options.fetchImpl ?? fetch

  let lastResult: SeatSyncResult | null = null
  for (let pass = 0; pass < 3; pass++) {
    const [billing] = await db
      .select({
        stripeSubscriptionId: workspaceBilling.stripeSubscriptionId,
        stripePriceId: workspaceBilling.stripePriceId,
        billingModel: workspaceBilling.billingModel,
        billingRevision: workspaceBilling.billingRevision,
        status: workspaceBilling.status,
        seats: workspaceBilling.seats,
      })
      .from(workspaceBilling)
      .where(eq(workspaceBilling.workspaceId, billingAccountWorkspaceId))
      .limit(1)

    if (!billing?.stripeSubscriptionId || billing.billingModel !== RESOURCE_BILLING_VERSION || !billing.stripePriceId) {
      return lastResult ?? { synced: false, reason: 'not_resource_subscription' }
    }
    if (billing.status !== 'active') {
      return lastResult ?? { synced: false, reason: 'inactive_subscription' }
    }
    if (!allowedPriceIds.includes(billing.stripePriceId)) {
      return lastResult ?? { synced: false, reason: 'unconfigured_price' }
    }

    const desired = await activeSeatCountForBillingAccount(billingAccountWorkspaceId)
    const rawSub = await stripeGet<unknown>(config, `subscriptions/${encodeURIComponent(billing.stripeSubscriptionId)}`, fetchImpl)
    const parsedSub = liveSubscriptionSchema.safeParse(rawSub)
    if (!parsedSub.success) return lastResult ?? { synced: false, reason: 'invalid_subscription' }
    const sub = parsedSub.data
    if (
      sub.id !== billing.stripeSubscriptionId
      || sub.status !== 'active'
      || sub.metadata.workspaceId !== billingAccountWorkspaceId
      || sub.metadata.billingModel !== RESOURCE_BILLING_VERSION
      || sub.items.data.length !== 1
    ) {
      return lastResult ?? { synced: false, reason: 'invalid_subscription' }
    }

    const item = sub.items.data[0]
    if (!allowedPriceIds.includes(item.price.id) || item.price.id !== billing.stripePriceId) {
      return lastResult ?? { synced: false, reason: 'unconfigured_price' }
    }
    const rawPrice = await stripeGet<unknown>(config, `prices/${encodeURIComponent(item.price.id)}`, fetchImpl)
    const approved = resourcePrice(rawPrice, item.price.id, { requireActive: false })
    if (approved.seatModel !== 'per_seat') {
      return { synced: false, reason: 'not_per_seat' }
    }

    const currentSeats = item.quantity ?? 1
    if (currentSeats === desired.seats) {
      if (billing.seats !== desired.seats) {
        await persistSeatsFenced({
          billingAccountWorkspaceId,
          subscriptionId: sub.id,
          priceId: item.price.id,
          expectedRevision: billing.billingRevision,
          previousSeats: currentSeats,
          seats: desired.seats,
          prorationBehavior: null,
        })
      }
      return lastResult ?? { synced: false, reason: 'unchanged', seats: desired.seats }
    }

    const prorationBehavior = desired.seats > currentSeats ? 'always_invoice' : 'create_prorations'
    await stripePost<unknown>(
      config,
      `subscription_items/${encodeURIComponent(item.id)}`,
      { quantity: desired.seats, proration_behavior: prorationBehavior },
      fetchImpl,
    )

    await persistSeatsFenced({
      billingAccountWorkspaceId,
      subscriptionId: sub.id,
      priceId: item.price.id,
      expectedRevision: billing.billingRevision,
      previousSeats: currentSeats,
      seats: desired.seats,
      prorationBehavior,
    })

    lastResult = { synced: true, previousSeats: currentSeats, seats: desired.seats, prorationBehavior }
    // Re-read canonical seat count after Stripe I/O so concurrent membership commits converge immediately.
    const latest = await activeSeatCountForBillingAccount(billingAccountWorkspaceId)
    if (latest.seats === desired.seats) return lastResult
  }

  return lastResult ?? { synced: false, reason: 'unchanged' }
}

/**
 * Synchronizes a live `per_seat` resource_v1 Stripe subscription's quantity to
 * match the billing account's canonical active human seat count.
 *
 * Refuses to run inside an open `workspaceDb` transaction so Stripe HTTP I/O
 * never holds workspace row locks:
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
  if (workspaceTransactionKey() !== null) {
    throw new Error('billing_seat_sync_inside_transaction')
  }
  return serializeAccountSync(billingAccountWorkspaceId, () => runSeatSync(billingAccountWorkspaceId, options))
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
  if (workspaceTransactionKey() !== null) {
    console.error('[billing] per-seat subscription sync skipped inside open workspace transaction')
    return
  }
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
 * Syncs the Organization's designated billing account when present; otherwise
 * syncs any affected attached workspaces that hold independent `per_seat`
 * subscriptions. Never throws into the enclosing membership mutation.
 */
export async function syncPerSeatSubscriptionForOrganization(
  organizationId: string,
  options: SyncOrganizationSeatsOptions = {},
): Promise<void> {
  if (!stripeConfig(options.env ?? runtimeEnv())) return
  if (workspaceTransactionKey() !== null) {
    console.error('[billing] organization per-seat subscription sync skipped inside open workspace transaction')
    return
  }
  try {
    const [account] = await workspaceDb
      .select({ workspaceId: organizationBillingAccounts.workspaceId })
      .from(organizationBillingAccounts)
      .innerJoin(organizations, eq(organizations.id, organizationBillingAccounts.organizationId))
      .where(and(eq(organizationBillingAccounts.organizationId, organizationId), isNull(organizations.archivedAt)))
      .limit(1)
    if (account) {
      await syncPerSeatSubscriptionQuantity(account.workspaceId, options)
      return
    }
    const workspaceIds = [...new Set(options.affectedWorkspaceIds ?? [])]
    for (const workspaceId of workspaceIds) {
      try {
        await syncPerSeatSubscriptionQuantity(workspaceId, options)
      } catch (error) {
        console.error('[billing] workspace per-seat subscription sync failed', {
          name: error instanceof Error ? error.name : 'UnknownError',
          status: error instanceof StripeRequestError ? error.status : null,
        })
      }
    }
  } catch (error) {
    console.error('[billing] organization per-seat subscription sync failed', {
      name: error instanceof Error ? error.name : 'UnknownError',
      status: error instanceof StripeRequestError ? error.status : null,
    })
  }
}
