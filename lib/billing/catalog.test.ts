import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { QUOTA_GATED_SIZES, selectableMachineSizeOptions } from '@/lib/cloud-computer/machine-pricing'
import {
  clearRuntimeConfigOverrides,
  overrideRuntimeConfig,
  resetRuntimeConfig,
  type BillingActiveOfferPayload,
} from '@/lib/runtime-config'
import {
  BILLING_CATALOG_PRICE_CACHE_TTL_MS,
  checkWorkspaceOfferEligibility,
  clearBillingCatalogCache,
  resolveBillingCatalog,
  resolveEligibleCheckoutOffer,
} from './catalog'
import {
  BillingCatalogError,
  billingCatalogKey,
  billingCatalogPath,
  billingCatalogViewSchema,
  DEFAULT_CREDIT_CONVERSION,
  deriveMachineSkuCatalog,
  fetchBillingCatalog,
  formatCatalogCurrency,
  formatCreditRateParams,
  formatMachineSkuParams,
  formatPlanSummaryParams,
} from './catalog-client'
import { resolveSubscriptionGrantPoints } from './subscription-webhook'

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const TEST_ENV = {
  NODE_ENV: 'test',
  MIKKA_EDITION: 'cloud',
  STRIPE_SECRET_KEY: 'sk_test_catalog_synthetic',
  STRIPE_TEAM_RESOURCE_PRICE_ID: 'price_resource_pro',
} as const

const STRIPE_RESOURCE_PRICE = {
  id: 'price_resource_pro',
  active: true,
  currency: 'usd',
  type: 'recurring',
  billing_scheme: 'per_unit',
  unit_amount: 2000,
  nickname: 'Pro Plan',
  recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
  metadata: {
    mikka_billing_model: 'resource_v1',
    mikka_plan: 'pro',
    mikka_monthly_points: '2000',
  },
}

const SAMPLE_OFFER: BillingActiveOfferPayload = {
  id: 'intro-month-1',
  kind: 'intro_period',
  planId: 'pro',
  introAmountCents: 500,
  introInterval: 'month',
  regularAmountCents: 2000,
  regularInterval: 'month',
  introCreditCents: 500,
  stripeCouponId: 'coupon_internal_secret',
  startAt: '2026-11-01T00:00:00Z',
  endAt: '2026-12-01T00:00:00Z',
}

function makeStripeFetch(price: unknown = STRIPE_RESOURCE_PRICE, status = 200) {
  const seenUrls: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    seenUrls.push(String(input))
    return new Response(JSON.stringify(price), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { fetchImpl, seenUrls }
}

const BILLING_ACCOUNT_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'

function makeMockPool(row: {
  hasPriorSubscription?: boolean
  hasPriorGrant?: boolean
  hasCheckoutRequest?: boolean
  cardClaimedElsewhere?: boolean
  unpaid24hMicroUsd?: number
} | Error): Pick<Pool, 'query'> & { calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  return {
    calls,
    query: (async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      if (row instanceof Error) throw row
      return {
        rows: [{
          hasPriorSubscription: row.hasPriorSubscription ?? false,
          hasPriorGrant: row.hasPriorGrant ?? false,
          hasCheckoutRequest: row.hasCheckoutRequest ?? false,
          cardClaimedElsewhere: row.cardClaimedElsewhere ?? false,
          unpaid24hMicroUsd: row.unpaid24hMicroUsd ?? 0,
        }],
      }
    }) as unknown as Pool['query'],
  }
}

function makeMockWorkspacePool(scope?: {
  organizationArchived?: boolean
  accountWorkspaceId?: string | null
} | Error): Pick<Pool, 'query'> & { calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  return {
    calls,
    query: (async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      if (scope instanceof Error) throw scope
      if (!scope) return { rows: [] }
      return {
        rows: [{
          organizationArchived: scope.organizationArchived ?? false,
          accountWorkspaceId: scope.accountWorkspaceId ?? null,
        }],
      }
    }) as unknown as Pool['query'],
  }
}

test('resolveBillingCatalog parses live Stripe resource price and caches by priceId for 60s', async () => {
  clearBillingCatalogCache()
  const { fetchImpl, seenUrls } = makeStripeFetch()
  const t0 = Date.parse('2026-11-15T12:00:00Z')

  const first = await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: TEST_ENV,
    fetchImpl,
    now: t0,
    activeOfferOverride: null,
  })
  assert.equal(seenUrls.length, 1)
  assert.equal(seenUrls[0], 'https://api.stripe.com/v1/prices/price_resource_pro')
  assert.equal(first.configured, true)
  assert.equal(first.currency, 'usd')
  assert.equal(first.fetchedAt, '2026-11-15T12:00:00.000Z')
  assert.deepEqual(first.plans, [{
    id: 'pro',
    plan: 'pro',
    name: 'Pro Plan',
    stripePriceId: 'price_resource_pro',
    amountCents: 2000,
    currency: 'usd',
    interval: 'month',
    includedCreditCents: 2000,
    includedPoints: 2000,
    seatModel: 'per_workspace',
    active: true,
  }])
  assert.equal(first.activeOffer, null)
  assert.deepEqual(first.creditConversion, DEFAULT_CREDIT_CONVERSION)
  assert.doesNotThrow(() => billingCatalogViewSchema.parse(first))

  // Within 60s TTL -> serves cached price with zero additional Stripe calls.
  await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: TEST_ENV,
    fetchImpl,
    now: t0 + BILLING_CATALOG_PRICE_CACHE_TTL_MS - 1,
    activeOfferOverride: null,
  })
  assert.equal(seenUrls.length, 1)

  // At/after 60s TTL -> re-fetches Stripe price.
  await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: TEST_ENV,
    fetchImpl,
    now: t0 + BILLING_CATALOG_PRICE_CACHE_TTL_MS,
    activeOfferOverride: null,
  })
  assert.equal(seenUrls.length, 2)
})

test('resolveBillingCatalog falls back gracefully without fabricating prices when Stripe is unconfigured or unreachable', async () => {
  clearBillingCatalogCache()
  let called = false
  const unexpectedFetch = (async () => {
    called = true
    throw new Error('should_not_fetch')
  }) as unknown as typeof fetch

  const unconfigured = await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: { NODE_ENV: 'test', MIKKA_EDITION: 'community' },
    fetchImpl: unexpectedFetch,
    now: new Date('2026-11-15T12:00:00Z'),
    activeOfferOverride: SAMPLE_OFFER,
    checkOfferEligibility: () => true,
  })
  assert.equal(called, false)
  assert.equal(unconfigured.configured, false)
  assert.deepEqual(unconfigured.plans, [])
  assert.equal(unconfigured.activeOffer, null)
  assert.equal(unconfigured.machineSkus.length, selectableMachineSizeOptions().length)

  // Configured Stripe returning HTTP 503 fails gracefully with empty plans and null activeOffer.
  const failing = makeStripeFetch({ error: { message: 'secret_internal_detail' } }, 503)
  const degraded = await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: TEST_ENV,
    fetchImpl: failing.fetchImpl,
    now: new Date('2026-11-15T12:00:00Z'),
    activeOfferOverride: SAMPLE_OFFER,
    checkOfferEligibility: () => true,
  })
  assert.equal(degraded.configured, true)
  assert.deepEqual(degraded.plans, [])
  assert.equal(degraded.activeOffer, null)
})

test('resolveBillingCatalog rejects invalid Stripe priceId formats before issuing any HTTP request (N5)', async () => {
  clearBillingCatalogCache()
  for (const badPriceId of ['../customers/cus_123', 'price_abc?expand[]=product', 'price_abc/extra', 'prod_not_a_price']) {
    const { fetchImpl, seenUrls } = makeStripeFetch()
    const result = await resolveBillingCatalog({
      workspaceId: WORKSPACE_ID,
      env: { ...TEST_ENV, STRIPE_TEAM_RESOURCE_PRICE_ID: badPriceId },
      fetchImpl,
      now: new Date('2026-11-15T12:00:00Z'),
      activeOfferOverride: SAMPLE_OFFER,
      checkOfferEligibility: () => true,
      bypassCache: true,
    })
    assert.equal(seenUrls.length, 0, `expected zero Stripe HTTP calls for invalid priceId: ${badPriceId}`)
    assert.equal(result.configured, true)
    assert.deepEqual(result.plans, [])
    assert.equal(result.activeOffer, null)
  }
})

test('resolveBillingCatalog evaluates activeOffer strictly server-side (eligible, ineligible, expired, runtime-config, plan match)', async () => {
  clearBillingCatalogCache()
  const { fetchImpl } = makeStripeFetch()
  const now = new Date('2026-11-15T12:00:00Z')

  try {
    // 1. Eligible via runtime-config billingActiveOffer; internal stripeCouponId is stripped from DTO.
    overrideRuntimeConfig('billingActiveOffer', SAMPLE_OFFER, TEST_ENV)
    const eligible = await resolveBillingCatalog({
      workspaceId: WORKSPACE_ID,
      env: TEST_ENV,
      fetchImpl,
      now,
      checkOfferEligibility: id => id === WORKSPACE_ID,
    })
    assert.deepEqual(eligible.activeOffer, {
      id: 'intro-month-1',
      kind: 'intro_period',
      planId: 'pro',
      introAmountCents: 500,
      introInterval: 'month',
      regularAmountCents: 2000,
      regularInterval: 'month',
      introCreditCents: 500,
      endsAt: '2026-12-01T00:00:00Z',
    })
    assert.equal('stripeCouponId' in (eligible.activeOffer ?? {}), false)

    // 2. Ineligible workspace (e.g. already subscribed or abuse-blocked) receives activeOffer: null.
    const ineligible = await resolveBillingCatalog({
      workspaceId: WORKSPACE_ID,
      env: TEST_ENV,
      fetchImpl,
      now,
      checkOfferEligibility: () => false,
    })
    assert.equal(ineligible.activeOffer, null)

    // 3. Missing workspaceId fails closed with activeOffer: null.
    const noWorkspace = await resolveBillingCatalog({
      workspaceId: null,
      env: TEST_ENV,
      fetchImpl,
      now,
      checkOfferEligibility: () => true,
    })
    assert.equal(noWorkspace.activeOffer, null)

    // 4. Expired offer (now >= endAt) returns activeOffer: null.
    const expired = await resolveBillingCatalog({
      workspaceId: WORKSPACE_ID,
      env: TEST_ENV,
      fetchImpl,
      now: new Date('2026-12-01T00:00:00Z'),
      activeOfferOverride: SAMPLE_OFFER,
      checkOfferEligibility: () => true,
    })
    assert.equal(expired.activeOffer, null)

    // 5. Not-yet-started offer (now < startAt) returns activeOffer: null.
    const future = await resolveBillingCatalog({
      workspaceId: WORKSPACE_ID,
      env: TEST_ENV,
      fetchImpl,
      now: new Date('2026-10-31T23:59:59Z'),
      activeOfferOverride: SAMPLE_OFFER,
      checkOfferEligibility: () => true,
    })
    assert.equal(future.activeOffer, null)

    // 6. Plan mismatch returns activeOffer: null.
    const wrongPlan = await resolveBillingCatalog({
      workspaceId: WORKSPACE_ID,
      env: TEST_ENV,
      fetchImpl,
      now,
      activeOfferOverride: { ...SAMPLE_OFFER, planId: 'enterprise' },
      checkOfferEligibility: () => true,
    })
    assert.equal(wrongPlan.activeOffer, null)

    // 7. Offer regularAmountCents / regularInterval mismatch against live Stripe plan fails closed (B6.1).
    const wrongRegularAmount = await resolveBillingCatalog({
      workspaceId: WORKSPACE_ID,
      env: TEST_ENV,
      fetchImpl,
      now,
      activeOfferOverride: { ...SAMPLE_OFFER, regularAmountCents: 2500 },
      checkOfferEligibility: () => true,
    })
    assert.equal(wrongRegularAmount.activeOffer, null)

    const wrongRegularInterval = await resolveBillingCatalog({
      workspaceId: WORKSPACE_ID,
      env: TEST_ENV,
      fetchImpl,
      now,
      activeOfferOverride: { ...SAMPLE_OFFER, regularInterval: 'year' },
      checkOfferEligibility: () => true,
    })
    assert.equal(wrongRegularInterval.activeOffer, null)

    // 8. Offer introCreditCents > includedCreditCents or introAmountCents > amountCents fails closed (B6.1).
    const excessiveIntroCredits = await resolveBillingCatalog({
      workspaceId: WORKSPACE_ID,
      env: TEST_ENV,
      fetchImpl,
      now,
      activeOfferOverride: { ...SAMPLE_OFFER, introCreditCents: 2001 },
      checkOfferEligibility: () => true,
    })
    assert.equal(excessiveIntroCredits.activeOffer, null)

    const excessiveIntroAmount = await resolveBillingCatalog({
      workspaceId: WORKSPACE_ID,
      env: TEST_ENV,
      fetchImpl,
      now,
      activeOfferOverride: { ...SAMPLE_OFFER, introAmountCents: 2001 },
      checkOfferEligibility: () => true,
    })
    assert.equal(excessiveIntroAmount.activeOffer, null)

    // 9. Org-bound non-payer workspace and prior checkout request fail closed via checkWorkspaceOfferEligibility (B6.2).
    const orgNonPayer = await resolveBillingCatalog({
      workspaceId: WORKSPACE_ID,
      env: TEST_ENV,
      fetchImpl,
      now,
      activeOfferOverride: SAMPLE_OFFER,
      checkOfferEligibility: id => checkWorkspaceOfferEligibility(id, {
        env: TEST_ENV,
        workspacePool: makeMockWorkspacePool({ accountWorkspaceId: BILLING_ACCOUNT_WORKSPACE_ID }),
        queryPool: makeMockPool({}),
      }),
    })
    assert.equal(orgNonPayer.activeOffer, null)

    const priorCheckout = await resolveBillingCatalog({
      workspaceId: WORKSPACE_ID,
      env: TEST_ENV,
      fetchImpl,
      now,
      activeOfferOverride: SAMPLE_OFFER,
      checkOfferEligibility: id => checkWorkspaceOfferEligibility(id, {
        env: TEST_ENV,
        workspacePool: makeMockWorkspacePool(),
        queryPool: makeMockPool({ hasCheckoutRequest: true }),
      }),
    })
    assert.equal(priorCheckout.activeOffer, null)
  } finally {
    clearRuntimeConfigOverrides(TEST_ENV)
    resetRuntimeConfig()
  }
})

test('checkWorkspaceOfferEligibility enforces org billing scope, checkout history, prior subscription/grant, abuse block, platform pause, and fail-closed DB errors', async () => {
  const env = { MIKKA_FREE_MODEL_DAILY_CENTS: '2500' } // 25_000_000 micro-USD

  const standaloneWsPool = makeMockWorkspacePool()
  const cleanAppPool = makeMockPool({})
  assert.equal(
    await checkWorkspaceOfferEligibility(WORKSPACE_ID, {
      env,
      workspacePool: standaloneWsPool,
      queryPool: cleanAppPool,
    }),
    true,
  )
  assert.equal(standaloneWsPool.calls.length, 1)
  assert.match(standaloneWsPool.calls[0].sql, /mikka_organization_workspaces/)
  assert.match(standaloneWsPool.calls[0].sql, /mikka_organization_billing_accounts/)
  assert.equal(cleanAppPool.calls.length, 1)
  assert.match(cleanAppPool.calls[0].sql, /billing_checkout_requests/)
  assert.match(cleanAppPool.calls[0].sql, /"closedAt" IS NULL/)
  assert.match(cleanAppPool.calls[0].sql, /mikka_offer_id/)
  assert.deepEqual(cleanAppPool.calls[0].params, [WORKSPACE_ID, null])

  // Designated org billing account itself remains eligible when clean.
  assert.equal(
    await checkWorkspaceOfferEligibility(WORKSPACE_ID, {
      env,
      workspacePool: makeMockWorkspacePool({ accountWorkspaceId: WORKSPACE_ID }),
      queryPool: makeMockPool({}),
    }),
    true,
  )

  // Org-bound workspace with a different designated billing account is ineligible and short-circuits before app DB query.
  const skippedAppPool = makeMockPool({})
  assert.equal(
    await checkWorkspaceOfferEligibility(WORKSPACE_ID, {
      env,
      workspacePool: makeMockWorkspacePool({ accountWorkspaceId: BILLING_ACCOUNT_WORKSPACE_ID }),
      queryPool: skippedAppPool,
    }),
    false,
  )
  assert.equal(skippedAppPool.calls.length, 0)

  // Archived organization fails closed.
  assert.equal(
    await checkWorkspaceOfferEligibility(WORKSPACE_ID, {
      env,
      workspacePool: makeMockWorkspacePool({ organizationArchived: true, accountWorkspaceId: null }),
      queryPool: makeMockPool({}),
    }),
    false,
  )

  // Workspace pool errors fail closed.
  assert.equal(
    await checkWorkspaceOfferEligibility(WORKSPACE_ID, {
      env,
      workspacePool: makeMockWorkspacePool(new Error('workspace_db_unavailable')),
      queryPool: makeMockPool({}),
    }),
    false,
  )

  assert.equal(
    await checkWorkspaceOfferEligibility(WORKSPACE_ID, {
      env,
      workspacePool: makeMockWorkspacePool(),
      queryPool: makeMockPool({ hasPriorSubscription: true }),
    }),
    false,
  )
  assert.equal(
    await checkWorkspaceOfferEligibility(WORKSPACE_ID, {
      env,
      workspacePool: makeMockWorkspacePool(),
      queryPool: makeMockPool({ hasPriorGrant: true }),
    }),
    false,
  )
  assert.equal(
    await checkWorkspaceOfferEligibility(WORKSPACE_ID, {
      env,
      workspacePool: makeMockWorkspacePool(),
      queryPool: makeMockPool({ hasCheckoutRequest: true }),
    }),
    false,
  )
  assert.equal(
    await checkWorkspaceOfferEligibility(WORKSPACE_ID, {
      env,
      workspacePool: makeMockWorkspacePool(),
      queryPool: makeMockPool({ cardClaimedElsewhere: true }),
    }),
    false,
  )
  assert.equal(
    await checkWorkspaceOfferEligibility(WORKSPACE_ID, {
      env,
      workspacePool: makeMockWorkspacePool(),
      queryPool: makeMockPool({ unpaid24hMicroUsd: 25_000_000 }),
    }),
    false,
  )
  assert.equal(
    await checkWorkspaceOfferEligibility('not-a-uuid', {
      env,
      workspacePool: makeMockWorkspacePool(),
      queryPool: makeMockPool({}),
    }),
    false,
  )
  assert.equal(
    await checkWorkspaceOfferEligibility(WORKSPACE_ID, {
      env,
      workspacePool: makeMockWorkspacePool(),
      queryPool: makeMockPool(new Error('db_unavailable')),
    }),
    false,
  )
})

test('machine SKUs derive directly from selectableMachineSizeOptions and exclude quota-gated sizes', () => {
  const skus = deriveMachineSkuCatalog()
  const selectable = selectableMachineSizeOptions()
  assert.equal(skus.length, selectable.length)
  assert.deepEqual(
    skus.map(sku => sku.id),
    selectable.map(option => option.id),
  )
  for (const sku of skus) {
    assert.equal(QUOTA_GATED_SIZES.has(sku.id), false)
    assert.equal(sku.provider, 'cloudflare')
    assert.equal(sku.hourlyRateCents, Math.round(sku.hourlyUsd * 100))
  }
  const defaultSku = skus.find(sku => sku.isDefault)
  assert.ok(defaultSku)
  assert.equal(defaultSku.id, 'standard-3')
  assert.equal(defaultSku.hourlyRateCents, 20)
})

test('catalog-client pure formatters, keys, and fetchBillingCatalog work without server-only dependencies', async () => {
  assert.equal(formatCatalogCurrency(2000, 'usd', 'en'), '$20')
  assert.equal(formatCatalogCurrency(20, 'usd', 'en'), '$0.20')
  assert.equal(formatCatalogCurrency(150, 'usd', 'en'), '$1.50')

  const planParams = formatPlanSummaryParams({
    id: 'pro',
    plan: 'pro',
    name: 'Pro',
    stripePriceId: 'price_resource_pro',
    amountCents: 2000,
    currency: 'usd',
    interval: 'month',
    includedCreditCents: 2000,
    includedPoints: 2000,
    seatModel: 'per_workspace',
    active: true,
  }, 'en')
  assert.equal(planParams.price, '$20')
  assert.equal(planParams.includedCredits, '$20')
  assert.equal(planParams.formattedPoints, '2,000')

  const skuParams = formatMachineSkuParams(deriveMachineSkuCatalog()[0], 'usd', 'en')
  assert.equal(skuParams.hourlyPrice, '$0.10')
  assert.equal(skuParams.memoryGib, 4)

  const rateParams = formatCreditRateParams(DEFAULT_CREDIT_CONVERSION, 'en')
  assert.equal(rateParams.amount, '$1')
  assert.equal(rateParams.points, 100)
  assert.deepEqual(rateParams.topUpAmounts.map(item => item.usd), [5, 10, 25, 50])

  assert.equal(billingCatalogPath(), '/api/billing/catalog')
  assert.equal(billingCatalogPath(WORKSPACE_ID), `/api/billing/catalog?workspace=${WORKSPACE_ID}`)
  assert.deepEqual(billingCatalogKey(WORKSPACE_ID), ['billing:catalog', WORKSPACE_ID])

  const sampleView = billingCatalogViewSchema.parse({
    currency: 'usd',
    configured: false,
    plans: [],
    creditConversion: DEFAULT_CREDIT_CONVERSION,
    machineSkus: deriveMachineSkuCatalog(),
    activeOffer: null,
    fetchedAt: '2026-11-15T12:00:00.000Z',
  })
  const okFetch = (async () => new Response(JSON.stringify(sampleView), { status: 200 })) as unknown as typeof fetch
  assert.deepEqual(await fetchBillingCatalog(WORKSPACE_ID, okFetch), sampleView)

  const errFetch = (async () => new Response(JSON.stringify({ error: 'workspaceAccessDenied' }), { status: 403 })) as unknown as typeof fetch
  await assert.rejects(
    fetchBillingCatalog(WORKSPACE_ID, errFetch),
    (error: unknown) => error instanceof BillingCatalogError && error.code === 'workspaceAccessDenied' && error.status === 403,
  )
})

test('subscription webhook enforces intro credit cap on subscription_create and grants full monthlyPoints on subscription_cycle renewals', () => {
  // Standard subscription_create without intro metadata grants full monthlyPoints.
  assert.equal(
    resolveSubscriptionGrantPoints({
      billingReason: 'subscription_create',
      monthlyPoints: 2000,
      subscriptionMetadata: { workspaceId: WORKSPACE_ID, billingModel: 'resource_v1' },
    }),
    2000,
  )

  // Intro subscription_create with mikka_intro_credit_cents on subscription metadata caps points.
  assert.equal(
    resolveSubscriptionGrantPoints({
      billingReason: 'subscription_create',
      monthlyPoints: 2000,
      subscriptionMetadata: { mikka_intro_credit_cents: '500' },
    }),
    500,
  )

  // Invoice metadata takes precedence when present, including zero-credit trials.
  assert.equal(
    resolveSubscriptionGrantPoints({
      billingReason: 'subscription_create',
      monthlyPoints: 2000,
      invoiceMetadata: { mikka_intro_credit_cents: '0' },
      subscriptionMetadata: { mikka_intro_credit_cents: '500' },
    }),
    0,
  )

  // Empty or whitespace-only invoiceMetadata falls through to subscriptionMetadata instead of bypassing the cap (B5).
  assert.equal(
    resolveSubscriptionGrantPoints({
      billingReason: 'subscription_create',
      monthlyPoints: 2000,
      invoiceMetadata: { mikka_intro_credit_cents: '' },
      subscriptionMetadata: { mikka_intro_credit_cents: '500' },
    }),
    500,
  )
  assert.equal(
    resolveSubscriptionGrantPoints({
      billingReason: 'subscription_create',
      monthlyPoints: 2000,
      invoiceMetadata: { mikka_intro_credit_cents: '   ' },
      subscriptionMetadata: { mikka_intro_credit_cents: '500' },
    }),
    500,
  )

  // Renewal (subscription_cycle) ALWAYS grants full monthlyPoints even when subscription metadata still carries intro cap from month 1.
  assert.equal(
    resolveSubscriptionGrantPoints({
      billingReason: 'subscription_cycle',
      monthlyPoints: 2000,
      subscriptionMetadata: { mikka_intro_credit_cents: '500' },
    }),
    2000,
  )

  // Malformed, negative, or excessive intro caps fail closed.
  assert.throws(
    () => resolveSubscriptionGrantPoints({
      billingReason: 'subscription_create',
      monthlyPoints: 2000,
      subscriptionMetadata: { mikka_intro_credit_cents: '2500' },
    }),
    /billing_intro_credit_cap_invalid/,
  )
  assert.throws(
    () => resolveSubscriptionGrantPoints({
      billingReason: 'subscription_create',
      monthlyPoints: 2000,
      subscriptionMetadata: { mikka_intro_credit_cents: '-100' },
    }),
    /billing_intro_credit_cap_invalid/,
  )
  assert.throws(
    () => resolveSubscriptionGrantPoints({
      billingReason: 'subscription_create',
      monthlyPoints: 2000,
      subscriptionMetadata: { mikka_intro_credit_cents: 'not-a-number' },
    }),
    /billing_intro_credit_cap_invalid/,
  )
})

test('resolveBillingCatalog and resolveEligibleCheckoutOffer require stripeCouponId for discounted intro offers and honor eligibility', async () => {
  clearBillingCatalogCache()
  const { fetchImpl } = makeStripeFetch()
  const now = new Date('2026-11-15T12:00:00Z')
  const plan = {
    id: 'pro',
    plan: 'pro' as const,
    name: 'Pro Plan',
    stripePriceId: 'price_resource_pro',
    amountCents: 2000,
    currency: 'usd',
    interval: 'month' as const,
    includedCreditCents: 2000,
    includedPoints: 2000,
    seatModel: 'per_workspace' as const,
    active: true,
  }

  // Discounted offer missing stripeCouponId must fail closed in both catalog and checkout.
  const { stripeCouponId: _omitted, ...discountedWithoutCoupon } = SAMPLE_OFFER
  const catalogWithoutCoupon = await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: TEST_ENV,
    fetchImpl,
    now,
    activeOfferOverride: discountedWithoutCoupon,
    checkOfferEligibility: () => true,
  })
  assert.equal(catalogWithoutCoupon.activeOffer, null)
  assert.equal(
    await resolveEligibleCheckoutOffer({
      workspaceId: WORKSPACE_ID,
      plan,
      env: TEST_ENV,
      now,
      activeOfferOverride: discountedWithoutCoupon,
      checkOfferEligibility: () => true,
    }),
    null,
  )

  // Valid discounted offer with stripeCouponId returns full checkout terms when eligible.
  const eligibleTerms = await resolveEligibleCheckoutOffer({
    workspaceId: WORKSPACE_ID,
    plan,
    env: TEST_ENV,
    now,
    activeOfferOverride: SAMPLE_OFFER,
    checkOfferEligibility: () => true,
  })
  assert.deepEqual(eligibleTerms, {
    id: 'intro-month-1',
    introCreditCents: 500,
    stripeCouponId: 'coupon_internal_secret',
  })

  // Unfulfillable offer cadence/kind/introPrice must fail closed in both catalog and checkout.
  const unfulfillableOffers: BillingActiveOfferPayload[] = [
    { ...SAMPLE_OFFER, id: 'weekly-on-monthly', introInterval: 'week' },
    { ...SAMPLE_OFFER, id: 'unsupported-trial', kind: 'trial' },
    { ...SAMPLE_OFFER, id: 'unsupported-intro-price', stripeIntroPriceId: 'price_intro_unsupported' },
  ]
  for (const badOffer of unfulfillableOffers) {
    const catalogBad = await resolveBillingCatalog({
      workspaceId: WORKSPACE_ID,
      env: TEST_ENV,
      fetchImpl,
      now,
      activeOfferOverride: badOffer,
      checkOfferEligibility: () => true,
    })
    assert.equal(catalogBad.activeOffer, null, `expected catalog activeOffer=null for ${badOffer.id}`)
    assert.equal(
      await resolveEligibleCheckoutOffer({
        workspaceId: WORKSPACE_ID,
        plan,
        env: TEST_ENV,
        now,
        activeOfferOverride: badOffer,
        checkOfferEligibility: () => true,
      }),
      null,
      `expected checkout offer=null for ${badOffer.id}`,
    )
  }

  // queryTx + skipOrgScopeCheck runs inside caller's advisory-locked Drizzle tx without hitting workspacePool.
  let txExecutions = 0
  const lockedTerms = await resolveEligibleCheckoutOffer({
    workspaceId: WORKSPACE_ID,
    plan,
    env: TEST_ENV,
    now,
    activeOfferOverride: SAMPLE_OFFER,
    skipOrgScopeCheck: true,
    queryTx: {
      execute: async () => {
        txExecutions += 1
        return {
          rows: [{
            hasPriorSubscription: false,
            hasPriorGrant: false,
            hasCheckoutRequest: false,
            cardClaimedElsewhere: false,
            unpaid24hMicroUsd: 0,
          }],
        }
      },
    },
  })
  assert.equal(txExecutions, 1)
  assert.deepEqual(lockedTerms, {
    id: 'intro-month-1',
    introCreditCents: 500,
    stripeCouponId: 'coupon_internal_secret',
  })

  // matchingOfferId is passed cleanly to open-checkout SQL so catalog parity holds for an open Checkout.
  const parityPool = makeMockPool({})
  assert.equal(
    await checkWorkspaceOfferEligibility(WORKSPACE_ID, {
      env: TEST_ENV,
      workspacePool: makeMockWorkspacePool(),
      queryPool: parityPool,
      matchingOfferId: 'intro-month-1',
    }),
    true,
  )
  assert.deepEqual(parityPool.calls[0].params, [WORKSPACE_ID, 'intro-month-1'])

  // Ineligible workspace or expired offer returns null.
  assert.equal(
    await resolveEligibleCheckoutOffer({
      workspaceId: WORKSPACE_ID,
      plan,
      env: TEST_ENV,
      now,
      activeOfferOverride: SAMPLE_OFFER,
      checkOfferEligibility: () => false,
    }),
    null,
  )
  assert.equal(
    await resolveEligibleCheckoutOffer({
      workspaceId: WORKSPACE_ID,
      plan,
      env: TEST_ENV,
      now: new Date('2026-12-02T00:00:00Z'),
      activeOfferOverride: SAMPLE_OFFER,
      checkOfferEligibility: () => true,
    }),
    null,
  )
})
