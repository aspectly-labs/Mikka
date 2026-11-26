import 'server-only'
/**
 * T3 — Server-side Billing Catalog resolver.
 *
 * Reads live plan pricing from Stripe (short 60s in-memory cache keyed by
 * priceId), derives machine SKUs from `lib/cloud-computer/machine-pricing.ts`,
 * and evaluates promotional offers strictly server-side against runtime config
 * (`billingActiveOffer`), time bounds, plan alignment, prior-subscription
 * history, and abuse/platform-pause eligibility.
 */
import type { Pool } from 'pg'
import { z } from 'zod'
import { abuseLimits } from '@/lib/abuse/policy'
import { runtimeEnv, type EnvMap } from '@/lib/env'
import {
  billingActiveOfferPayloadSchema,
  getRuntimeConfig,
  type BillingActiveOfferPayload,
} from '@/lib/runtime-config'
import {
  billingActiveOfferSchema,
  billingCatalogViewSchema,
  billingPlanCatalogEntrySchema,
  creditConversionSchema,
  DEFAULT_CREDIT_CONVERSION,
  deriveMachineSkuCatalog,
  machineSkuCatalogEntrySchema,
  type BillingActiveOffer,
  type BillingCatalogView,
  type BillingPlanCatalogEntry,
  type CreditConversionMetadata,
  type MachineSkuCatalogEntry,
} from './catalog-client'
import { POINTS_PER_USD } from './hosted-usage'
import { resourcePrice } from './resource-plan'
import { stripeConfig, stripeGet, StripeRequestError, type StripeConfig } from './stripe'

export {
  billingActiveOfferSchema,
  billingCatalogViewSchema,
  billingPlanCatalogEntrySchema,
  creditConversionSchema,
  DEFAULT_CREDIT_CONVERSION,
  deriveMachineSkuCatalog,
  machineSkuCatalogEntrySchema,
  type BillingActiveOffer,
  type BillingCatalogView,
  type BillingPlanCatalogEntry,
  type CreditConversionMetadata,
  type MachineSkuCatalogEntry,
}

export const BILLING_CATALOG_PRICE_CACHE_TTL_MS = 60_000

interface CachedPriceEntry {
  plan: BillingPlanCatalogEntry
  fetchedAtMs: number
}

const priceCache = new Map<string, CachedPriceEntry>()

/** Clears the in-memory Stripe price catalog cache (primarily for deterministic tests). */
export function clearBillingCatalogCache(): void {
  priceCache.clear()
}

const DEFAULT_PLAN_DISPLAY_NAMES: Readonly<Record<'pro' | 'enterprise', string>> = {
  pro: 'Pro',
  enterprise: 'Enterprise',
}

function defaultPlanDisplayName(plan: 'pro' | 'enterprise'): string {
  return DEFAULT_PLAN_DISPLAY_NAMES[plan]
}

function toPlanCatalogEntry(rawPrice: unknown, configuredPriceId: string): BillingPlanCatalogEntry {
  const approved = resourcePrice(rawPrice, configuredPriceId)
  const rawNickname = typeof (rawPrice as { nickname?: unknown } | null)?.nickname === 'string'
    ? (rawPrice as { nickname: string }).nickname.trim()
    : ''
  const includedCreditCents = Math.floor((approved.monthlyPoints * 100) / POINTS_PER_USD)
  return billingPlanCatalogEntrySchema.parse({
    id: approved.plan,
    plan: approved.plan,
    name: rawNickname || defaultPlanDisplayName(approved.plan),
    stripePriceId: approved.id,
    amountCents: approved.amountCents,
    currency: approved.currency,
    interval: 'month',
    includedCreditCents,
    includedPoints: approved.monthlyPoints,
    seatModel: 'per_workspace',
    active: true,
  })
}

const STRIPE_PRICE_ID_RE = /^price_[A-Za-z0-9_]+$/

async function fetchCachedResourcePlan(
  config: StripeConfig,
  priceId: string,
  nowMs: number,
  fetchImpl: typeof fetch,
  bypassCache: boolean,
): Promise<BillingPlanCatalogEntry | null> {
  if (!STRIPE_PRICE_ID_RE.test(priceId)) {
    console.error('[billing] catalog price lookup rejected invalid price id')
    return null
  }
  if (!bypassCache) {
    const cached = priceCache.get(priceId)
    if (
      cached
      && nowMs >= cached.fetchedAtMs
      && nowMs - cached.fetchedAtMs < BILLING_CATALOG_PRICE_CACHE_TTL_MS
    ) {
      return cached.plan
    }
  }

  try {
    const raw = await stripeGet<unknown>(config, `prices/${encodeURIComponent(priceId)}`, fetchImpl)
    const entry = toPlanCatalogEntry(raw, priceId)
    priceCache.set(priceId, { plan: entry, fetchedAtMs: nowMs })
    return entry
  } catch (error) {
    console.error('[billing] catalog price lookup failed', {
      name: error instanceof Error ? error.name : 'UnknownError',
      status: error instanceof StripeRequestError ? error.status : null,
    })
    return null
  }
}

interface OrganizationBillingScopeRow {
  organizationArchived: boolean
  accountWorkspaceId: string | null
}

interface OfferEligibilityRow {
  hasPriorSubscription: boolean
  hasPriorGrant: boolean
  hasCheckoutRequest: boolean
  cardClaimedElsewhere: boolean
  unpaid24hMicroUsd: number
}

export interface WorkspaceOfferEligibilityOptions {
  env?: EnvMap
  queryPool?: Pick<Pool, 'query'>
  workspacePool?: Pick<Pool, 'query'>
}

/**
 * Server-side promotional offer eligibility check for a workspace.
 *
 * Fails closed (`false`) unless ALL conditions hold:
 * 1. Valid workspace UUID;
 * 2. Workspace is not bound to an archived organization or an organization with
 *    a different designated billing account (per `lib/billing/authority.ts`);
 * 3. No prior or current Stripe subscription history on `workspace_billing`,
 *    no prior plan or intro grant in `workspace_credit_grants`, and no in-flight
 *    or past checkout requests in `billing_checkout_requests` on the effective
 *    billing account workspace;
 * 4. No cross-workspace card fingerprint reuse signal and platform not paused
 *    under the 24-hour unpaid spend abuse ceiling.
 */
export async function checkWorkspaceOfferEligibility(
  workspaceId: string,
  options: WorkspaceOfferEligibilityOptions = {},
): Promise<boolean> {
  if (!z.uuid().safeParse(workspaceId).success) return false
  const env = options.env ?? runtimeEnv()
  try {
    const targetWorkspacePool = options.workspacePool ?? (await import('@/lib/workspace-db')).workspacePool
    const { rows: [orgScope] } = await targetWorkspacePool.query<OrganizationBillingScopeRow>(
      `SELECT
        (o.id IS NULL OR o."archivedAt" IS NOT NULL) AS "organizationArchived",
        oba."workspaceId" AS "accountWorkspaceId"
      FROM mikka_organization_workspaces ow
      LEFT JOIN mikka_organizations o ON o.id = ow."organizationId"
      LEFT JOIN mikka_organization_billing_accounts oba ON oba."organizationId" = ow."organizationId"
      WHERE ow."workspaceId" = $1
      LIMIT 1`,
      [workspaceId],
    )
    if (orgScope?.organizationArchived) return false
    const accountWorkspaceId = orgScope?.accountWorkspaceId ?? null
    if (accountWorkspaceId !== null && accountWorkspaceId !== workspaceId) return false
    const billingWorkspaceId = accountWorkspaceId ?? workspaceId

    const targetPool = options.queryPool ?? (await import('@/lib/db')).pool
    const { rows: [row] } = await targetPool.query<OfferEligibilityRow>(
      `SELECT
        EXISTS(
          SELECT 1 FROM workspace_billing
          WHERE "workspaceId"=$1
            AND ("stripeSubscriptionId" IS NOT NULL
              OR "billingInvoiceId" IS NOT NULL
              OR "billingRevision">0
              OR COALESCE(status,'')<>'')
        ) AS "hasPriorSubscription",
        EXISTS(
          SELECT 1 FROM workspace_credit_grants
          WHERE "workspaceId"=$1
            AND (bucket='plan' OR reason IN ('subscription','intro_offer','intro_period'))
        ) AS "hasPriorGrant",
        EXISTS(
          SELECT 1 FROM billing_checkout_requests
          WHERE "workspaceId"=$1
        ) AS "hasCheckoutRequest",
        EXISTS(
          SELECT 1 FROM hosted_verifications v
          JOIN hosted_card_claims c ON c.fingerprint=v.fingerprint
          WHERE v."workspaceId"=$1
            AND v.fingerprint IS NOT NULL
            AND c."workspaceId"<>$1
        ) AS "cardClaimedElsewhere",
        COALESCE((
          SELECT sum("unpaidMicroUsd"+CASE WHEN state IN ('pending','unknown') THEN "reservedUnpaid" ELSE 0 END)
          FROM hosted_usage
          WHERE "createdAt">now()-interval '24 hours'
        ),0)::float8 AS "unpaid24hMicroUsd"`,
      [billingWorkspaceId],
    )
    if (!row) return false
    if (
      row.hasPriorSubscription
      || row.hasPriorGrant
      || row.hasCheckoutRequest
      || row.cardClaimedElsewhere
    ) return false
    const limits = abuseLimits(env)
    if (row.unpaid24hMicroUsd >= limits.dailyMicroUsd) return false
    return true
  } catch (error) {
    console.error('[billing] offer eligibility check failed', {
      name: error instanceof Error ? error.name : 'UnknownError',
    })
    return false
  }
}

function offerMatchesActivePlan(
  offer: BillingActiveOfferPayload,
  plans: readonly BillingPlanCatalogEntry[],
): boolean {
  const matchedPlan = plans.find(
    plan => plan.active && (plan.id === offer.planId || plan.plan === offer.planId),
  )
  if (!matchedPlan) return false
  return (
    offer.regularAmountCents === matchedPlan.amountCents
    && offer.regularInterval === matchedPlan.interval
    && offer.introCreditCents <= matchedPlan.includedCreditCents
    && offer.introAmountCents <= matchedPlan.amountCents
  )
}

function isOfferWindowActive(offer: BillingActiveOfferPayload, nowMs: number): boolean {
  if (!Number.isFinite(nowMs)) return false
  const endMs = Date.parse(offer.endAt)
  if (Number.isNaN(endMs) || nowMs >= endMs) return false
  if (offer.startAt !== undefined) {
    const startMs = Date.parse(offer.startAt)
    if (Number.isNaN(startMs) || startMs >= endMs || nowMs < startMs) return false
  }
  return true
}

export interface ResolveBillingCatalogOptions {
  workspaceId?: string | null
  env?: EnvMap
  fetchImpl?: typeof fetch
  now?: Date | number
  activeOfferOverride?: BillingActiveOfferPayload | null
  checkOfferEligibility?: (workspaceId: string) => Promise<boolean> | boolean
  bypassCache?: boolean
}

/**
 * Resolves the authoritative server-side billing catalog for the requested
 * workspace. Never fabricates Stripe prices when billing is unconfigured or
 * Stripe is unreachable, and evaluates promotional offers strictly server-side.
 */
export async function resolveBillingCatalog(
  options: ResolveBillingCatalogOptions = {},
): Promise<BillingCatalogView> {
  const env = options.env ?? runtimeEnv()
  const fetchImpl = options.fetchImpl ?? fetch
  const nowMs = options.now instanceof Date ? options.now.getTime() : (options.now ?? Date.now())
  const config = stripeConfig(env)
  const plans: BillingPlanCatalogEntry[] = []

  if (config?.resourcePriceId) {
    const entry = await fetchCachedResourcePlan(
      config,
      config.resourcePriceId,
      nowMs,
      fetchImpl,
      options.bypassCache ?? false,
    )
    if (entry) plans.push(entry)
  }

  let activeOffer: BillingActiveOffer | null = null
  const rawCandidate = options.activeOfferOverride !== undefined
    ? options.activeOfferOverride
    : getRuntimeConfig('billingActiveOffer', { env, now: nowMs })

  if (rawCandidate !== null && rawCandidate !== undefined && plans.length > 0 && options.workspaceId) {
    const parsedOffer = billingActiveOfferPayloadSchema.safeParse(rawCandidate)
    if (
      parsedOffer.success
      && isOfferWindowActive(parsedOffer.data, nowMs)
      && offerMatchesActivePlan(parsedOffer.data, plans)
    ) {
      const eligibilityCheck = options.checkOfferEligibility
        ?? ((id: string) => checkWorkspaceOfferEligibility(id, { env }))
      let eligible = false
      try {
        eligible = Boolean(await eligibilityCheck(options.workspaceId))
      } catch (error) {
        console.error('[billing] offer eligibility callback failed', {
          name: error instanceof Error ? error.name : 'UnknownError',
        })
        eligible = false
      }
      if (eligible) {
        activeOffer = billingActiveOfferSchema.parse({
          id: parsedOffer.data.id,
          kind: parsedOffer.data.kind,
          planId: parsedOffer.data.planId,
          introAmountCents: parsedOffer.data.introAmountCents,
          introInterval: parsedOffer.data.introInterval,
          regularAmountCents: parsedOffer.data.regularAmountCents,
          regularInterval: parsedOffer.data.regularInterval,
          introCreditCents: parsedOffer.data.introCreditCents,
          endsAt: parsedOffer.data.endAt,
        })
      }
    }
  }

  return billingCatalogViewSchema.parse({
    currency: plans[0]?.currency ?? DEFAULT_CREDIT_CONVERSION.currency,
    configured: Boolean(config),
    plans,
    creditConversion: DEFAULT_CREDIT_CONVERSION,
    machineSkus: deriveMachineSkuCatalog(),
    activeOffer,
    fetchedAt: new Date(nowMs).toISOString(),
  })
}
