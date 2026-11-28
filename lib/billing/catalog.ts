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
import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { z } from 'zod'
import { abuseLimits } from '@/lib/abuse/policy'
import { looksLikeSecretValue } from '@/lib/audit/events'
import { runtimeEnv, type EnvMap } from '@/lib/env'
import {
  billingActiveOfferPayloadSchema,
  ensureRuntimeConfigLoaded,
  getRuntimeConfig,
  type BillingActiveOfferPayload,
} from '@/lib/runtime-config'
import {
  billingActiveOfferSchema,
  billingCatalogViewSchema,
  billingPlanCatalogEntrySchema,
  creditConversionSchema,
  DEFAULT_CREDIT_CONVERSION,
  deriveE2BMachineSkuCatalog,
  deriveMachineSkuCatalog,
  machineSkuCatalogEntrySchema,
  type BillingActiveOffer,
  type BillingCatalogView,
  type BillingPlanCatalogEntry,
  type CreditConversionMetadata,
  type MachineSkuCatalogEntry,
} from './catalog-client'
import { pointsToCreditCents } from './hosted-usage'
import { resourcePrice } from './resource-plan'
import { configuredResourcePriceIds, stripeConfig, stripeGet, StripeRequestError, type StripeConfig } from './stripe'

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
/**
 * Minimum remaining offer validity required to admit an offer into catalog or
 * Checkout. Kept strictly above `plan-checkout.ts`'s 31m post-transaction
 * Stripe POST cutoff (4m headroom for floor truncation + `requireNoSubscription`).
 */
export const MIN_OFFER_CHECKOUT_WINDOW_MS = 35 * 60_000

const STRIPE_PRODUCT_ID_RE = /^prod_[A-Za-z0-9_]+$/

/** Extracts the Stripe product ID from a raw Stripe Price object (string or expanded object). */
export function extractStripeProductId(rawPrice: unknown): string | null {
  if (!rawPrice || typeof rawPrice !== 'object') return null
  const product = (rawPrice as { product?: unknown }).product
  if (typeof product === 'string' && STRIPE_PRODUCT_ID_RE.test(product)) return product
  if (product && typeof product === 'object') {
    const id = (product as { id?: unknown }).id
    if (typeof id === 'string' && STRIPE_PRODUCT_ID_RE.test(id)) return id
  }
  return null
}

const stripeCouponSchema = z.object({
  id: z.string().min(1),
  valid: z.boolean(),
  duration: z.enum(['forever', 'once', 'repeating']),
  amount_off: z.number().int().positive().nullish(),
  percent_off: z.number().gt(0).lte(100).nullish(),
  currency: z.string().min(1).nullish(),
  redeem_by: z.number().int().positive().nullish(),
  max_redemptions: z.number().int().positive().nullish(),
  times_redeemed: z.number().int().nonnegative().nullish(),
  applies_to: z.object({ products: z.array(z.string().min(1)).optional() }).loose().nullish(),
  deleted: z.boolean().optional(),
}).loose()

type StripeCoupon = z.infer<typeof stripeCouponSchema>

interface CachedPriceEntry {
  plan: BillingPlanCatalogEntry
  productId: string | null
  fetchedAtMs: number
}

interface CachedCouponEntry {
  coupon: StripeCoupon
  fetchedAtMs: number
}

const priceCache = new Map<string, CachedPriceEntry>()
const couponCache = new Map<string, CachedCouponEntry>()

/** Clears the in-memory Stripe price and coupon catalog caches (primarily for deterministic tests). */
export function clearBillingCatalogCache(): void {
  priceCache.clear()
  couponCache.clear()
}

const DEFAULT_PLAN_DISPLAY_NAMES: Readonly<Record<'pro' | 'team' | 'enterprise', string>> = {
  pro: 'Mikka Pro',
  team: 'Mikka Team',
  enterprise: 'Mikka Enterprise',
}

function defaultPlanDisplayName(id: 'pro' | 'team' | 'enterprise'): string {
  return DEFAULT_PLAN_DISPLAY_NAMES[id]
}

export function billingCatalogPlanId(plan: 'pro' | 'enterprise', seatModel: 'per_workspace' | 'per_seat'): 'pro' | 'team' | 'enterprise' {
  return plan === 'pro' && seatModel === 'per_seat' ? 'team' : plan
}

function toPlanCatalogEntry(rawPrice: unknown, configuredPriceId: string): BillingPlanCatalogEntry {
  const approved = resourcePrice(rawPrice, configuredPriceId)
  const rawNickname = typeof (rawPrice as { nickname?: unknown } | null)?.nickname === 'string'
    ? (rawPrice as { nickname: string }).nickname.trim()
    : ''
  const includedCreditCents = pointsToCreditCents(approved.monthlyPoints)
  const id = billingCatalogPlanId(approved.plan, approved.seatModel)
  return billingPlanCatalogEntrySchema.parse({
    id,
    plan: approved.plan,
    name: rawNickname || defaultPlanDisplayName(id),
    stripePriceId: approved.id,
    amountCents: approved.amountCents,
    currency: approved.currency,
    interval: 'month',
    includedCreditCents,
    includedPoints: approved.monthlyPoints,
    seatModel: approved.seatModel,
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
): Promise<{ plan: BillingPlanCatalogEntry; productId: string | null } | null> {
  if (!STRIPE_PRICE_ID_RE.test(priceId)) {
    console.error('[billing] catalog price lookup rejected invalid price id')
    return null
  }
  if (!bypassCache) {
    const cached = priceCache.get(priceId)
    if (cached && Math.abs(nowMs - cached.fetchedAtMs) < BILLING_CATALOG_PRICE_CACHE_TTL_MS) {
      return { plan: cached.plan, productId: cached.productId }
    }
  }

  try {
    const raw = await stripeGet<unknown>(config, `prices/${encodeURIComponent(priceId)}`, fetchImpl)
    const entry = toPlanCatalogEntry(raw, priceId)
    const productId = extractStripeProductId(raw)
    priceCache.set(priceId, { plan: entry, productId, fetchedAtMs: nowMs })
    return { plan: entry, productId }
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

export interface DrizzleExecuteLike {
  execute: (query: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }>
}

export interface WorkspaceOfferEligibilityOptions {
  env?: EnvMap
  queryPool?: Pick<Pool, 'query'>
  queryTx?: DrizzleExecuteLike
  workspacePool?: Pick<Pool, 'query'>
  /** Skip workspacePool org-scope read when caller already holds `withBillingAuthority(..., { ownPlatformAccount: true })`. */
  skipOrgScopeCheck?: boolean
  /** Open unexpired Checkout sessions created for this exact offer ID remain consistent with catalog display. */
  matchingOfferId?: string | null
}

/**
 * Server-side promotional offer eligibility check for a workspace.
 *
 * Fails closed (`false`) unless ALL conditions hold:
 * 1. Valid workspace UUID;
 * 2. Workspace is not bound to an archived organization or an organization with
 *    a different designated billing account (per `lib/billing/authority.ts`);
 * 3. No prior or current Stripe subscription history on `workspace_billing`,
 *    no prior plan or intro grant in `workspace_credit_grants`, and no open
 *    unexpired non-matching checkout request in `billing_checkout_requests` on
 *    the effective billing account workspace;
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
    let billingWorkspaceId = workspaceId
    if (!options.skipOrgScopeCheck) {
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
      billingWorkspaceId = accountWorkspaceId ?? workspaceId
    }

    const matchingOfferId = options.matchingOfferId ?? null
    let row: OfferEligibilityRow | undefined
    if (options.queryTx) {
      const result = await options.queryTx.execute(sql`
        SELECT
          EXISTS(
            SELECT 1 FROM workspace_billing
            WHERE "workspaceId"=${billingWorkspaceId}
              AND ("stripeSubscriptionId" IS NOT NULL
                OR "billingInvoiceId" IS NOT NULL
                OR "billingRevision">0
                OR COALESCE(status,'')<>'')
          ) AS "hasPriorSubscription",
          EXISTS(
            SELECT 1 FROM workspace_credit_grants
            WHERE "workspaceId"=${billingWorkspaceId}
              AND (bucket='plan' OR reason IN ('subscription','intro_offer','intro_period'))
          ) AS "hasPriorGrant",
          EXISTS(
            SELECT 1 FROM billing_checkout_requests
            WHERE "workspaceId"=${billingWorkspaceId}
              AND "closedAt" IS NULL
              AND "expiresAt" > now()
              AND (${matchingOfferId}::text IS NULL OR COALESCE(params->'metadata'->>'mikka_offer_id', '') <> ${matchingOfferId})
          ) AS "hasCheckoutRequest",
          EXISTS(
            SELECT 1 FROM hosted_verifications v
            JOIN hosted_card_claims c ON c.fingerprint=v.fingerprint
            WHERE v."workspaceId"=${billingWorkspaceId}
              AND v.fingerprint IS NOT NULL
              AND c."workspaceId"<>${billingWorkspaceId}
          ) AS "cardClaimedElsewhere",
          COALESCE((
            SELECT sum("unpaidMicroUsd"+CASE WHEN state IN ('pending','unknown') THEN "reservedUnpaid" ELSE 0 END)
            FROM hosted_usage
            WHERE "createdAt">now()-interval '24 hours'
          ),0)::float8 AS "unpaid24hMicroUsd"
      `)
      row = result.rows[0] as OfferEligibilityRow | undefined
    } else {
      const targetPool = options.queryPool ?? (await import('@/lib/db')).pool
      const { rows } = await targetPool.query<OfferEligibilityRow>(
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
              AND "closedAt" IS NULL
              AND "expiresAt" > now()
              AND ($2::text IS NULL OR COALESCE(params->'metadata'->>'mikka_offer_id', '') <> $2)
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
        [billingWorkspaceId, matchingOfferId],
      )
      row = rows[0]
    }
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

const STRIPE_COUPON_ID_RE = /^[A-Za-z0-9_-]{1,255}$/

async function fetchCachedStripeCoupon(
  config: StripeConfig,
  couponId: string,
  nowMs: number,
  fetchImpl: typeof fetch,
  bypassCache: boolean,
): Promise<StripeCoupon | null> {
  if (!STRIPE_COUPON_ID_RE.test(couponId)) {
    console.error('[billing] catalog coupon lookup rejected invalid coupon id')
    return null
  }
  if (!bypassCache) {
    const cached = couponCache.get(couponId)
    if (cached && Math.abs(nowMs - cached.fetchedAtMs) < BILLING_CATALOG_PRICE_CACHE_TTL_MS) {
      return cached.coupon
    }
  }

  try {
    const raw = await stripeGet<unknown>(
      config,
      `coupons/${encodeURIComponent(couponId)}?expand[]=applies_to`,
      fetchImpl,
    )
    const parsed = stripeCouponSchema.safeParse(raw)
    if (!parsed.success || parsed.data.deleted || !parsed.data.valid) {
      couponCache.delete(couponId)
      return null
    }
    couponCache.set(couponId, { coupon: parsed.data, fetchedAtMs: nowMs })
    return parsed.data
  } catch (error) {
    couponCache.delete(couponId)
    console.error('[billing] catalog coupon lookup failed', {
      name: error instanceof Error ? error.name : 'UnknownError',
      status: error instanceof StripeRequestError ? error.status : null,
    })
    return null
  }
}

function couponMatchesOffer(
  coupon: StripeCoupon,
  offer: BillingActiveOfferPayload,
  plan: BillingPlanCatalogEntry,
  planProductId: string | null,
  nowMs: number,
): { ok: true; effectiveEndMs: number } | { ok: false } {
  if (coupon.deleted || !coupon.valid) return { ok: false }
  if (coupon.max_redemptions != null && (coupon.times_redeemed ?? 0) >= coupon.max_redemptions) {
    return { ok: false }
  }
  if (coupon.id !== offer.stripeCouponId) return { ok: false }
  // First-invoice intro offers must never attach repeating/forever coupons.
  if (coupon.duration !== 'once') return { ok: false }

  const restrictedProducts = coupon.applies_to?.products
  if (restrictedProducts && restrictedProducts.length > 0) {
    if (!planProductId || !restrictedProducts.includes(planProductId)) return { ok: false }
  }

  const offerEndMs = Date.parse(offer.endAt)
  const effectiveEndMs = coupon.redeem_by != null
    ? Math.min(offerEndMs, coupon.redeem_by * 1000)
    : offerEndMs
  if (!Number.isFinite(effectiveEndMs) || effectiveEndMs - nowMs < MIN_OFFER_CHECKOUT_WINDOW_MS) {
    return { ok: false }
  }

  const hasAmountOff = coupon.amount_off != null
  const hasPercentOff = coupon.percent_off != null
  if (hasAmountOff === hasPercentOff) return { ok: false }

  let discountedAmountCents: number
  if (hasAmountOff) {
    if (!coupon.currency || coupon.currency.toLowerCase() !== plan.currency.toLowerCase()) {
      return { ok: false }
    }
    discountedAmountCents = Math.max(0, plan.amountCents - coupon.amount_off!)
  } else {
    // Stripe stores percent_off to 2 decimal places (basis points); use exact integer
    // half-up rounding to avoid IEEE-754 float drift (e.g. 100 * (14.5 / 100) < 14.5).
    const scaled = coupon.percent_off! * 100
    const percentBps = Math.round(scaled)
    if (!Number.isSafeInteger(percentBps) || Math.abs(scaled - percentBps) > 1e-6) {
      return { ok: false }
    }
    const discountCents = Math.floor((plan.amountCents * percentBps + 5_000) / 10_000)
    discountedAmountCents = Math.max(0, plan.amountCents - discountCents)
  }

  if (discountedAmountCents !== offer.introAmountCents) return { ok: false }
  return { ok: true, effectiveEndMs }
}

function matchActivePlanForOffer(
  offer: BillingActiveOfferPayload,
  plans: readonly BillingPlanCatalogEntry[],
): BillingPlanCatalogEntry | null {
  const matchedPlan = plans.find(plan => plan.active && plan.id === offer.planId)
    ?? plans.find(plan => plan.active && plan.plan === offer.planId)
  if (!matchedPlan) return null
  // Coupon-only Checkout on a recurring resourcePriceId can only fulfill
  // intro_period / discount offers whose billing cadence matches the plan's
  // recurring interval (no separate intro price or trial_period_days yet).
  if (offer.kind === 'trial') return null
  if (offer.stripeIntroPriceId) return null
  if (offer.introInterval !== matchedPlan.interval) return null
  // Discounted intro offers require a verified coupon; un-discounted offers
  // must NEVER attach a coupon (prevents catalog/Checkout price mismatch).
  if (offer.introAmountCents < matchedPlan.amountCents && !offer.stripeCouponId) return null
  if (offer.introAmountCents === matchedPlan.amountCents && offer.stripeCouponId) return null
  if (
    offer.regularAmountCents !== matchedPlan.amountCents
    || offer.regularInterval !== matchedPlan.interval
    || offer.introCreditCents > matchedPlan.includedCreditCents
    || offer.introAmountCents > matchedPlan.amountCents
  ) {
    return null
  }
  return matchedPlan
}

function isOfferWindowActive(offer: BillingActiveOfferPayload, nowMs: number): boolean {
  if (!Number.isFinite(nowMs)) return false
  const endMs = Date.parse(offer.endAt)
  if (Number.isNaN(endMs) || endMs - nowMs < MIN_OFFER_CHECKOUT_WINDOW_MS) return false
  if (offer.startAt !== undefined) {
    const startMs = Date.parse(offer.startAt)
    if (Number.isNaN(startMs) || startMs >= endMs || nowMs < startMs) return false
  }
  return true
}

export interface VerifiedCandidateOffer {
  readonly payload: BillingActiveOfferPayload
  readonly endsAt: string
  readonly endsAtMs: number
}

async function verifyCandidateOffer(input: {
  rawCandidate: unknown
  plans: readonly BillingPlanCatalogEntry[]
  planProductIds?: ReadonlyMap<string, string | null>
  config: StripeConfig | null
  fetchImpl: typeof fetch
  nowMs: number
  bypassCache: boolean
}): Promise<VerifiedCandidateOffer | null> {
  if (input.rawCandidate === null || input.rawCandidate === undefined) return null
  const parsedOffer = billingActiveOfferPayloadSchema.safeParse(input.rawCandidate)
  if (!parsedOffer.success) return null
  const offer = parsedOffer.data
  // Reject secret-shaped offer IDs up front so `recordAudit` never throws during Checkout.
  if (looksLikeSecretValue(offer.id)) return null
  if (!isOfferWindowActive(offer, input.nowMs)) return null
  const matchedPlan = matchActivePlanForOffer(offer, input.plans)
  if (!matchedPlan) return null

  const offerEndMs = Date.parse(offer.endAt)
  let effectiveEndMs = offerEndMs
  if (offer.stripeCouponId) {
    if (!input.config) return null
    const coupon = await fetchCachedStripeCoupon(
      input.config,
      offer.stripeCouponId,
      input.nowMs,
      input.fetchImpl,
      input.bypassCache,
    )
    if (!coupon) return null
    const planProductId = matchedPlan.stripePriceId
      ? (input.planProductIds?.get(matchedPlan.stripePriceId) ?? null)
      : null
    const matched = couponMatchesOffer(coupon, offer, matchedPlan, planProductId, input.nowMs)
    if (!matched.ok) return null
    effectiveEndMs = matched.effectiveEndMs
  }

  const endsAt = effectiveEndMs === offerEndMs
    ? offer.endAt
    : new Date(effectiveEndMs).toISOString()

  return { payload: offer, endsAt, endsAtMs: effectiveEndMs }
}

/**
 * Warms runtime config on cold containers and Stripe-verifies any active
 * promotional offer BEFORE entering `resourcePlanCheckout`'s advisory-locked DB
 * transaction so no network I/O ever runs while holding a DB lock.
 */
export async function prepareCheckoutOfferCandidate(input: {
  plan: BillingPlanCatalogEntry
  planProductId?: string | null
  config: StripeConfig
  env?: EnvMap
  fetchImpl?: typeof fetch
  now?: Date | number
  activeOfferOverride?: BillingActiveOfferPayload | null
  bypassCache?: boolean
}): Promise<VerifiedCandidateOffer | null> {
  const env = input.env ?? runtimeEnv()
  const explicitNow = input.now !== undefined
  const initialNowMs = input.now instanceof Date ? input.now.getTime() : (input.now ?? Date.now())
  if (input.activeOfferOverride === undefined) {
    await ensureRuntimeConfigLoaded({ env, ...(explicitNow ? { now: initialNowMs } : {}) })
  }
  const nowMs = explicitNow ? initialNowMs : Date.now()
  const rawCandidate = input.activeOfferOverride !== undefined
    ? input.activeOfferOverride
    : getRuntimeConfig('billingActiveOffer', { env, now: nowMs })
  const planProductIds = input.planProductId !== undefined && input.plan.stripePriceId
    ? new Map<string, string | null>([[input.plan.stripePriceId, input.planProductId]])
    : undefined
  return verifyCandidateOffer({
    rawCandidate,
    plans: [input.plan],
    planProductIds,
    config: input.config,
    fetchImpl: input.fetchImpl ?? fetch,
    nowMs,
    bypassCache: input.bypassCache ?? true,
  })
}

export interface CheckoutOfferTerms {
  readonly id: string
  readonly introCreditCents: number
  readonly stripeCouponId?: string
  readonly endsAt: string
}

/**
 * Resolves server-verified promotional offer terms for an active Checkout
 * creation using the exact same validation and eligibility rules as
 * `resolveBillingCatalog`. Must be called inside `resourcePlanCheckout`'s
 * `pg_advisory_xact_lock` transaction (`queryTx`) with a `preverifiedOffer`
 * prepared before the transaction so eligibility and Checkout creation are
 * serialized atomically without network I/O inside the lock.
 */
export async function resolveEligibleCheckoutOffer(input: {
  workspaceId: string
  plan: BillingPlanCatalogEntry
  planProductId?: string | null
  env?: EnvMap
  now?: Date | number
  queryTx?: DrizzleExecuteLike
  skipOrgScopeCheck?: boolean
  activeOfferOverride?: BillingActiveOfferPayload | null
  preverifiedOffer?: VerifiedCandidateOffer | null
  stripeConfig?: StripeConfig | null
  fetchImpl?: typeof fetch
  bypassCache?: boolean
  checkOfferEligibility?: (workspaceId: string) => Promise<boolean> | boolean
}): Promise<CheckoutOfferTerms | null> {
  const env = input.env ?? runtimeEnv()
  const explicitNow = input.now !== undefined
  const nowMs = input.now instanceof Date ? input.now.getTime() : (input.now ?? Date.now())

  let verified: VerifiedCandidateOffer | null
  if (input.preverifiedOffer !== undefined) {
    if (
      input.preverifiedOffer === null
      || !Number.isFinite(nowMs)
      || input.preverifiedOffer.endsAtMs - nowMs < MIN_OFFER_CHECKOUT_WINDOW_MS
      || looksLikeSecretValue(input.preverifiedOffer.payload.id)
      || !matchActivePlanForOffer(input.preverifiedOffer.payload, [input.plan])
    ) {
      return null
    }
    verified = input.preverifiedOffer
  } else {
    if (input.activeOfferOverride === undefined) {
      await ensureRuntimeConfigLoaded({ env, ...(explicitNow ? { now: nowMs } : {}) })
    }
    const evalNowMs = explicitNow ? nowMs : Date.now()
    const rawCandidate = input.activeOfferOverride !== undefined
      ? input.activeOfferOverride
      : getRuntimeConfig('billingActiveOffer', { env, now: evalNowMs })
    const config = input.stripeConfig !== undefined ? input.stripeConfig : stripeConfig(env)
    const planProductIds = input.planProductId !== undefined && input.plan.stripePriceId
      ? new Map<string, string | null>([[input.plan.stripePriceId, input.planProductId]])
      : undefined
    verified = await verifyCandidateOffer({
      rawCandidate,
      plans: [input.plan],
      planProductIds,
      config,
      fetchImpl: input.fetchImpl ?? fetch,
      nowMs: evalNowMs,
      bypassCache: input.bypassCache ?? false,
    })
  }
  if (!verified) return null

  const eligibilityCheck = input.checkOfferEligibility
    ?? ((id: string) => checkWorkspaceOfferEligibility(id, {
      env,
      queryTx: input.queryTx,
      skipOrgScopeCheck: input.skipOrgScopeCheck,
    }))
  let eligible = false
  try {
    eligible = Boolean(await eligibilityCheck(input.workspaceId))
  } catch (error) {
    console.error('[billing] offer eligibility callback failed', {
      name: error instanceof Error ? error.name : 'UnknownError',
    })
    eligible = false
  }
  if (!eligible) return null
  return {
    id: verified.payload.id,
    introCreditCents: verified.payload.introCreditCents,
    endsAt: verified.endsAt,
    ...(verified.payload.stripeCouponId ? { stripeCouponId: verified.payload.stripeCouponId } : {}),
  }
}

export interface ResolveBillingCatalogOptions {
  workspaceId?: string | null
  env?: EnvMap
  fetchImpl?: typeof fetch
  now?: Date | number
  activeOfferOverride?: BillingActiveOfferPayload | null
  checkOfferEligibility?: (workspaceId: string) => Promise<boolean> | boolean
  bypassCache?: boolean
  includeE2BMachineSkus?: boolean
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
  const explicitNow = options.now !== undefined
  const nowMs = options.now instanceof Date ? options.now.getTime() : (options.now ?? Date.now())
  const config = stripeConfig(env)
  const plans: BillingPlanCatalogEntry[] = []
  const planProductIds = new Map<string, string | null>()

  const priceIds = configuredResourcePriceIds(config)
  if (config && priceIds.length > 0) {
    const fetchedPlans = await Promise.all(
      priceIds.map(priceId => fetchCachedResourcePlan(
        config,
        priceId,
        nowMs,
        fetchImpl,
        options.bypassCache ?? false,
      )),
    )
    for (const fetched of fetchedPlans) {
      if (!fetched) continue
      plans.push(fetched.plan)
      if (fetched.plan.stripePriceId) {
        planProductIds.set(fetched.plan.stripePriceId, fetched.productId)
      }
    }
  }

  let activeOffer: BillingActiveOffer | null = null
  if (plans.length > 0 && options.workspaceId) {
    if (options.activeOfferOverride === undefined) {
      await ensureRuntimeConfigLoaded({ env, ...(explicitNow ? { now: nowMs } : {}) })
    }
    const offerNowMs = explicitNow ? nowMs : Date.now()
    const rawCandidate = options.activeOfferOverride !== undefined
      ? options.activeOfferOverride
      : getRuntimeConfig('billingActiveOffer', { env, now: offerNowMs })
    const verified = await verifyCandidateOffer({
      rawCandidate,
      plans,
      planProductIds,
      config,
      fetchImpl,
      nowMs: offerNowMs,
      bypassCache: options.bypassCache ?? false,
    })
    if (verified) {
      const eligibilityCheck = options.checkOfferEligibility
        ?? ((id: string) => checkWorkspaceOfferEligibility(id, {
          env,
          matchingOfferId: verified.payload.id,
        }))
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
          id: verified.payload.id,
          kind: verified.payload.kind,
          planId: verified.payload.planId,
          introAmountCents: verified.payload.introAmountCents,
          introInterval: verified.payload.introInterval,
          regularAmountCents: verified.payload.regularAmountCents,
          regularInterval: verified.payload.regularInterval,
          introCreditCents: verified.payload.introCreditCents,
          endsAt: verified.endsAt,
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
    ...(options.includeE2BMachineSkus ? { e2bMachineSkus: deriveE2BMachineSkuCatalog() } : {}),
    activeOffer,
    fetchedAt: new Date(nowMs).toISOString(),
  })
}
