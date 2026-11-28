import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { QUOTA_GATED_SIZES, selectableMachineSizeOptions } from '@/lib/cloud-computer/machine-pricing'
import {
  clearRuntimeConfigOverrides,
  overrideRuntimeConfig,
  resetRuntimeConfig,
  setRuntimeConfigAdapter,
  type BillingActiveOfferPayload,
} from '@/lib/runtime-config'
import {
  BILLING_CATALOG_PRICE_CACHE_TTL_MS,
  checkWorkspaceOfferEligibility,
  clearBillingCatalogCache,
  prepareCheckoutOfferCandidate,
  resolveBillingCatalog,
  resolveEligibleCheckoutOffer,
} from './catalog'
import {
  BillingCatalogError,
  billingCatalogKey,
  billingCatalogPath,
  billingCatalogViewSchema,
  DEFAULT_CREDIT_CONVERSION,
  deriveE2BMachineSkuCatalog,
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

const MATCHING_STRIPE_COUPON = {
  id: 'coupon_internal_secret',
  valid: true,
  duration: 'once',
  amount_off: 1500,
  currency: 'usd',
}

function makeStripeFetch(
  price: unknown = STRIPE_RESOURCE_PRICE,
  status = 200,
  coupons: Record<string, { body: unknown; status?: number }> = {
    coupon_internal_secret: { body: MATCHING_STRIPE_COUPON },
  },
) {
  const seenUrls: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const rawUrl = String(input)
    seenUrls.push(rawUrl)
    const parsed = new URL(rawUrl)
    if (parsed.pathname.startsWith('/v1/coupons/')) {
      const couponId = decodeURIComponent(parsed.pathname.slice('/v1/coupons/'.length))
      const entry = coupons[couponId]
      if (!entry) {
        return new Response(JSON.stringify({ error: { message: 'No such coupon' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(entry.body), {
        status: entry.status ?? 200,
        headers: { 'content-type': 'application/json' },
      })
    }
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
  assert.equal('e2bMachineSkus' in unconfigured, false)

  const withE2B = await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: { NODE_ENV: 'test', MIKKA_EDITION: 'community' },
    fetchImpl: unexpectedFetch,
    now: new Date('2026-11-15T12:00:00Z'),
    activeOfferOverride: SAMPLE_OFFER,
    checkOfferEligibility: () => true,
    includeE2BMachineSkus: true,
  })
  assert.equal(withE2B.e2bMachineSkus?.length, 4)

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

  const e2bSkus = deriveE2BMachineSkuCatalog()
  assert.deepEqual(
    e2bSkus.map(sku => [sku.id, sku.hourlyRateCents, sku.perSecondMicroUsd, sku.provider, sku.isDefault]),
    [
      ['small', 12, 32, 'e2b', false],
      ['medium', 23, 64, 'e2b', true],
      ['large', 46, 128, 'e2b', false],
      ['ultra', 92, 256, 'e2b', false],
    ],
  )
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

test('resolveBillingCatalog and resolveEligibleCheckoutOffer require verified Stripe coupons for discounted intro offers and honor eligibility', async () => {
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
      fetchImpl,
      now,
      activeOfferOverride: discountedWithoutCoupon,
      checkOfferEligibility: () => true,
    }),
    null,
  )

  // Un-discounted offer with a stray stripeCouponId must fail closed (never discount silently).
  const undiscountedWithCoupon: BillingActiveOfferPayload = {
    ...SAMPLE_OFFER,
    id: 'undiscounted-with-coupon',
    introAmountCents: 2000,
    stripeCouponId: 'coupon_internal_secret',
  }
  const catalogUndiscountedWithCoupon = await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: TEST_ENV,
    fetchImpl,
    now,
    activeOfferOverride: undiscountedWithCoupon,
    checkOfferEligibility: () => true,
  })
  assert.equal(catalogUndiscountedWithCoupon.activeOffer, null)
  assert.equal(
    await resolveEligibleCheckoutOffer({
      workspaceId: WORKSPACE_ID,
      plan,
      env: TEST_ENV,
      fetchImpl,
      now,
      activeOfferOverride: undiscountedWithCoupon,
      checkOfferEligibility: () => true,
    }),
    null,
  )

  // Un-discounted offer WITHOUT stripeCouponId passes cleanly without fetching Stripe coupons.
  const { fetchImpl: noCouponFetch, seenUrls: noCouponUrls } = makeStripeFetch(STRIPE_RESOURCE_PRICE, 200, {})
  const { stripeCouponId: _unused, ...undiscountedClean } = { ...SAMPLE_OFFER, id: 'credit-cap-only', introAmountCents: 2000 }
  const catalogUndiscounted = await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: TEST_ENV,
    fetchImpl: noCouponFetch,
    now,
    activeOfferOverride: undiscountedClean,
    checkOfferEligibility: () => true,
    bypassCache: true,
  })
  assert.equal(catalogUndiscounted.activeOffer?.id, 'credit-cap-only')
  assert.equal(noCouponUrls.some(url => url.includes('/coupons/')), false)

  // Valid discounted offer with verified Stripe coupon returns full checkout terms including endsAt.
  const eligibleTerms = await resolveEligibleCheckoutOffer({
    workspaceId: WORKSPACE_ID,
    plan,
    env: TEST_ENV,
    fetchImpl,
    now,
    activeOfferOverride: SAMPLE_OFFER,
    checkOfferEligibility: () => true,
  })
  assert.deepEqual(eligibleTerms, {
    id: 'intro-month-1',
    introCreditCents: 500,
    stripeCouponId: 'coupon_internal_secret',
    endsAt: '2026-12-01T00:00:00Z',
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
        fetchImpl,
        now,
        activeOfferOverride: badOffer,
        checkOfferEligibility: () => true,
      }),
      null,
      `expected checkout offer=null for ${badOffer.id}`,
    )
  }

  // queryTx + skipOrgScopeCheck runs inside caller's advisory-locked Drizzle tx without hitting workspacePool or Stripe when preverified.
  const preverified = await prepareCheckoutOfferCandidate({
    plan,
    config: {
      secretKey: TEST_ENV.STRIPE_SECRET_KEY,
      teamPriceId: null,
      resourcePriceId: TEST_ENV.STRIPE_TEAM_RESOURCE_PRICE_ID,
      webhookSecret: null,
    },
    env: TEST_ENV,
    fetchImpl,
    now,
    activeOfferOverride: SAMPLE_OFFER,
  })
  assert.ok(preverified)
  let txExecutions = 0
  const lockedTerms = await resolveEligibleCheckoutOffer({
    workspaceId: WORKSPACE_ID,
    plan,
    env: TEST_ENV,
    now,
    preverifiedOffer: preverified,
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
    endsAt: '2026-12-01T00:00:00Z',
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

  // Ineligible workspace or expired/soon-expiring (<31m) offer returns null in both catalog and checkout.
  assert.equal(
    await resolveEligibleCheckoutOffer({
      workspaceId: WORKSPACE_ID,
      plan,
      env: TEST_ENV,
      fetchImpl,
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
      fetchImpl,
      now: new Date('2026-12-02T00:00:00Z'),
      activeOfferOverride: SAMPLE_OFFER,
      checkOfferEligibility: () => true,
    }),
    null,
  )
  const twentyMinutesBeforeEnd = new Date(Date.parse(SAMPLE_OFFER.endAt) - 20 * 60_000)
  const soonExpiringCatalog = await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: TEST_ENV,
    fetchImpl,
    now: twentyMinutesBeforeEnd,
    activeOfferOverride: SAMPLE_OFFER,
    checkOfferEligibility: () => true,
  })
  assert.equal(soonExpiringCatalog.activeOffer, null)
  assert.equal(
    await resolveEligibleCheckoutOffer({
      workspaceId: WORKSPACE_ID,
      plan,
      env: TEST_ENV,
      fetchImpl,
      now: twentyMinutesBeforeEnd,
      activeOfferOverride: SAMPLE_OFFER,
      checkOfferEligibility: () => true,
    }),
    null,
  )
})

test('resolveBillingCatalog and resolveEligibleCheckoutOffer verify Stripe coupon terms (percent_off, duration, amount, currency, valid, redeem_by)', async () => {
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

  // percent_off: 75 on $20.00 yields $5.00 -> passes and clamps endsAt to coupon.redeem_by when earlier than offer.endAt.
  clearBillingCatalogCache()
  const earlyRedeemBySec = Math.floor(Date.parse('2026-11-20T00:00:00Z') / 1000)
  const percentFetch = makeStripeFetch(STRIPE_RESOURCE_PRICE, 200, {
    coupon_pct75: {
      body: {
        id: 'coupon_pct75',
        valid: true,
        duration: 'once',
        percent_off: 75,
        redeem_by: earlyRedeemBySec,
      },
    },
  })
  const percentOffer: BillingActiveOfferPayload = { ...SAMPLE_OFFER, stripeCouponId: 'coupon_pct75' }
  const percentCatalog = await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: TEST_ENV,
    fetchImpl: percentFetch.fetchImpl,
    now,
    activeOfferOverride: percentOffer,
    checkOfferEligibility: () => true,
  })
  assert.equal(percentCatalog.activeOffer?.endsAt, '2026-11-20T00:00:00.000Z')
  const percentCheckout = await resolveEligibleCheckoutOffer({
    workspaceId: WORKSPACE_ID,
    plan,
    env: TEST_ENV,
    fetchImpl: percentFetch.fetchImpl,
    now,
    activeOfferOverride: percentOffer,
    checkOfferEligibility: () => true,
  })
  assert.equal(percentCheckout?.endsAt, '2026-11-20T00:00:00.000Z')

  // Reject invalid, deleted, repeating/forever, wrong-amount, wrong-percent, wrong-currency, expired redeem_by, missing, and invalid-id coupons.
  const badCouponCases: Array<{ label: string; couponId: string; response?: { body: unknown; status?: number } }> = [
    { label: 'invalid/exhausted coupon', couponId: 'coupon_exhausted', response: { body: { id: 'coupon_exhausted', valid: false, duration: 'once', amount_off: 1500, currency: 'usd' } } },
    { label: 'deleted coupon', couponId: 'coupon_deleted', response: { body: { id: 'coupon_deleted', valid: true, deleted: true, duration: 'once', amount_off: 1500, currency: 'usd' } } },
    { label: 'repeating duration', couponId: 'coupon_repeating', response: { body: { id: 'coupon_repeating', valid: true, duration: 'repeating', amount_off: 1500, currency: 'usd' } } },
    { label: 'forever duration', couponId: 'coupon_forever', response: { body: { id: 'coupon_forever', valid: true, duration: 'forever', amount_off: 1500, currency: 'usd' } } },
    { label: 'mismatched amount_off', couponId: 'coupon_wrong_amt', response: { body: { id: 'coupon_wrong_amt', valid: true, duration: 'once', amount_off: 1000, currency: 'usd' } } },
    { label: 'mismatched percent_off', couponId: 'coupon_wrong_pct', response: { body: { id: 'coupon_wrong_pct', valid: true, duration: 'once', percent_off: 50 } } },
    { label: 'mismatched currency', couponId: 'coupon_eur', response: { body: { id: 'coupon_eur', valid: true, duration: 'once', amount_off: 1500, currency: 'eur' } } },
    { label: 'expired redeem_by', couponId: 'coupon_past_redeem', response: { body: { id: 'coupon_past_redeem', valid: true, duration: 'once', amount_off: 1500, currency: 'usd', redeem_by: Math.floor(now.getTime() / 1000) + 600 } } },
    { label: 'missing 404 coupon', couponId: 'coupon_missing' },
    { label: 'path traversal coupon id', couponId: '../prices/price_123' },
  ]

  for (const testCase of badCouponCases) {
    clearBillingCatalogCache()
    const coupons = testCase.response ? { [testCase.couponId]: testCase.response } : {}
    const { fetchImpl: badFetch, seenUrls } = makeStripeFetch(STRIPE_RESOURCE_PRICE, 200, coupons)
    const offer: BillingActiveOfferPayload = { ...SAMPLE_OFFER, stripeCouponId: testCase.couponId }
    const cat = await resolveBillingCatalog({
      workspaceId: WORKSPACE_ID,
      env: TEST_ENV,
      fetchImpl: badFetch,
      now,
      activeOfferOverride: offer,
      checkOfferEligibility: () => true,
      bypassCache: true,
    })
    assert.equal(cat.activeOffer, null, `expected catalog activeOffer=null for ${testCase.label}`)
    if (testCase.couponId.includes('..')) {
      assert.equal(seenUrls.some(url => url.includes('/coupons/')), false, 'must reject invalid coupon id before Stripe request')
    }
    const checkout = await resolveEligibleCheckoutOffer({
      workspaceId: WORKSPACE_ID,
      plan,
      env: TEST_ENV,
      fetchImpl: badFetch,
      now,
      activeOfferOverride: offer,
      checkOfferEligibility: () => true,
      bypassCache: true,
    })
    assert.equal(checkout, null, `expected checkout offer=null for ${testCase.label}`)
  }
})

test('resolveBillingCatalog and prepareCheckoutOfferCandidate warm cold runtime config before reading billingActiveOffer', async () => {
  clearBillingCatalogCache()
  resetRuntimeConfig()
  clearRuntimeConfigOverrides(TEST_ENV)
  const { fetchImpl } = makeStripeFetch()
  const now = new Date('2026-11-15T12:00:00Z')
  let adapterCalls = 0
  try {
    setRuntimeConfigAdapter({
      name: 'cold-start-offer-adapter',
      async fetchPayloads() {
        adapterCalls += 1
        return {
          'mikka-config-billing-active-offer': SAMPLE_OFFER,
        }
      },
    })

    // Cold catalog read must await runtime config load and immediately surface activeOffer.
    const catalog = await resolveBillingCatalog({
      workspaceId: WORKSPACE_ID,
      env: TEST_ENV,
      fetchImpl,
      now,
      checkOfferEligibility: () => true,
    })
    assert.equal(adapterCalls, 1)
    assert.equal(catalog.activeOffer?.id, SAMPLE_OFFER.id)

    // Cold checkout candidate preparation on a fresh process must also await runtime config load.
    resetRuntimeConfig()
    adapterCalls = 0
    setRuntimeConfigAdapter({
      name: 'cold-start-checkout-adapter',
      async fetchPayloads() {
        adapterCalls += 1
        return {
          'mikka-config-billing-active-offer': SAMPLE_OFFER,
        }
      },
    })
    const candidate = await prepareCheckoutOfferCandidate({
      plan: catalog.plans[0],
      config: {
      secretKey: TEST_ENV.STRIPE_SECRET_KEY,
      teamPriceId: null,
      resourcePriceId: TEST_ENV.STRIPE_TEAM_RESOURCE_PRICE_ID,
      webhookSecret: null,
    },
      env: TEST_ENV,
      fetchImpl,
      now,
    })
    assert.equal(adapterCalls, 1)
    assert.equal(candidate?.payload.id, SAMPLE_OFFER.id)
    assert.equal(candidate?.endsAt, SAMPLE_OFFER.endAt)
  } finally {
    clearRuntimeConfigOverrides(TEST_ENV)
    resetRuntimeConfig()
    clearBillingCatalogCache()
  }
})

test('resolveBillingCatalog and resolveEligibleCheckoutOffer enforce applies_to.products, integer bps percent_off, max_redemptions, audit-safe offer IDs, and 35m expiry margin', async () => {
  const now = new Date('2026-11-15T12:00:00Z')
  const priceWithProduct = { ...STRIPE_RESOURCE_PRICE, product: 'prod_resource_pro' }
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

  // 1. Coupon with applies_to.products matching plan product passes and requests ?expand[]=applies_to.
  clearBillingCatalogCache()
  const scopedFetch = makeStripeFetch(priceWithProduct, 200, {
    coupon_scoped: {
      body: {
        id: 'coupon_scoped',
        valid: true,
        duration: 'once',
        amount_off: 1500,
        currency: 'usd',
        applies_to: { products: ['prod_resource_pro'] },
      },
    },
  })
  const scopedOffer: BillingActiveOfferPayload = { ...SAMPLE_OFFER, stripeCouponId: 'coupon_scoped' }
  const scopedCatalog = await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: TEST_ENV,
    fetchImpl: scopedFetch.fetchImpl,
    now,
    activeOfferOverride: scopedOffer,
    checkOfferEligibility: () => true,
  })
  assert.equal(scopedCatalog.activeOffer?.id, SAMPLE_OFFER.id)
  assert.ok(scopedFetch.seenUrls.some(url => url.includes('/v1/coupons/coupon_scoped?expand[]=applies_to')))

  // 2. Coupon restricted to a different product (or missing product on price) fails closed.
  clearBillingCatalogCache()
  const wrongProductFetch = makeStripeFetch(priceWithProduct, 200, {
    coupon_other_prod: {
      body: {
        id: 'coupon_other_prod',
        valid: true,
        duration: 'once',
        amount_off: 1500,
        currency: 'usd',
        applies_to: { products: ['prod_different'] },
      },
    },
  })
  const wrongProductOffer: BillingActiveOfferPayload = { ...SAMPLE_OFFER, stripeCouponId: 'coupon_other_prod' }
  const wrongProductCatalog = await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: TEST_ENV,
    fetchImpl: wrongProductFetch.fetchImpl,
    now,
    activeOfferOverride: wrongProductOffer,
    checkOfferEligibility: () => true,
  })
  assert.equal(wrongProductCatalog.activeOffer, null)
  assert.equal(
    await resolveEligibleCheckoutOffer({
      workspaceId: WORKSPACE_ID,
      plan,
      planProductId: null,
      env: TEST_ENV,
      fetchImpl: scopedFetch.fetchImpl,
      now,
      activeOfferOverride: scopedOffer,
      checkOfferEligibility: () => true,
    }),
    null,
  )

  // 3. Fractional percent_off uses exact integer basis-points half-up math (avoiding IEEE-754 14.499999999999998 drift).
  clearBillingCatalogCache()
  const tenDollarPrice = { ...STRIPE_RESOURCE_PRICE, unit_amount: 1000 }
  const fracFetch = makeStripeFetch(tenDollarPrice, 200, {
    coupon_frac_pct: {
      body: {
        id: 'coupon_frac_pct',
        valid: true,
        duration: 'once',
        percent_off: 1.45, // 1.45% of 1000c = 14.5c -> rounds half-up to 15c -> 985c
      },
    },
  })
  const fracOffer: BillingActiveOfferPayload = {
    ...SAMPLE_OFFER,
    regularAmountCents: 1000,
    introAmountCents: 985,
    stripeCouponId: 'coupon_frac_pct',
  }
  const fracCatalog = await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: TEST_ENV,
    fetchImpl: fracFetch.fetchImpl,
    now,
    activeOfferOverride: fracOffer,
    checkOfferEligibility: () => true,
    bypassCache: true,
  })
  assert.equal(fracCatalog.activeOffer?.introAmountCents, 985)

  // 4. amount_off exceeding plan.amountCents clamps to 0 and matches introAmountCents: 0; times_redeemed >= max_redemptions fails closed.
  clearBillingCatalogCache()
  const fullDiscountFetch = makeStripeFetch(STRIPE_RESOURCE_PRICE, 200, {
    coupon_full: {
      body: {
        id: 'coupon_full',
        valid: true,
        duration: 'once',
        amount_off: 2500,
        currency: 'usd',
      },
    },
    coupon_maxed: {
      body: {
        id: 'coupon_maxed',
        valid: true,
        duration: 'once',
        amount_off: 1500,
        currency: 'usd',
        max_redemptions: 10,
        times_redeemed: 10,
      },
    },
  })
  const freeFirstMonth = await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: TEST_ENV,
    fetchImpl: fullDiscountFetch.fetchImpl,
    now,
    activeOfferOverride: { ...SAMPLE_OFFER, introAmountCents: 0, stripeCouponId: 'coupon_full' },
    checkOfferEligibility: () => true,
    bypassCache: true,
  })
  assert.equal(freeFirstMonth.activeOffer?.introAmountCents, 0)
  const maxedCatalog = await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: TEST_ENV,
    fetchImpl: fullDiscountFetch.fetchImpl,
    now,
    activeOfferOverride: { ...SAMPLE_OFFER, stripeCouponId: 'coupon_maxed' },
    checkOfferEligibility: () => true,
    bypassCache: true,
  })
  assert.equal(maxedCatalog.activeOffer, null)

  // 5. Secret-shaped, whitespace-only, and 31m+500ms-expiring offers fail closed; padded IDs trim cleanly.
  clearBillingCatalogCache()
  const { fetchImpl } = makeStripeFetch()
  for (const badId of ['   ', 'sk-promo-2026-november-launch']) {
    const res = await resolveBillingCatalog({
      workspaceId: WORKSPACE_ID,
      env: TEST_ENV,
      fetchImpl,
      now,
      activeOfferOverride: { ...SAMPLE_OFFER, id: badId },
      checkOfferEligibility: () => true,
    })
    assert.equal(res.activeOffer, null, `expected null for offer id: ${JSON.stringify(badId)}`)
  }
  const paddedCatalog = await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: TEST_ENV,
    fetchImpl,
    now,
    activeOfferOverride: { ...SAMPLE_OFFER, id: '  intro-padded  ' },
    checkOfferEligibility: () => true,
  })
  assert.equal(paddedCatalog.activeOffer?.id, 'intro-padded')

  const thirtyOneMinPlusHalfSec = new Date(Date.parse(SAMPLE_OFFER.endAt) - (31 * 60_000 + 500))
  const boundaryCatalog = await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: TEST_ENV,
    fetchImpl,
    now: thirtyOneMinPlusHalfSec,
    activeOfferOverride: SAMPLE_OFFER,
    checkOfferEligibility: () => true,
  })
  assert.equal(boundaryCatalog.activeOffer, null)
})

test('catalog surfaces per_seat pricing and at-cost default unit_amount credits', async () => {
  const seatFetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/v1/prices/price_team_1')) {
      return Response.json({
        id: 'price_team_1',
        active: true,
        currency: 'usd',
        type: 'recurring',
        billing_scheme: 'per_unit',
        unit_amount: 3000,
        recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
        metadata: {
          mikka_billing_model: 'resource_v1',
          mikka_plan: 'pro',
          mikka_seat_model: 'per_seat',
          mikka_pricing_model: 'at_cost_v1',
        },
      })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  const catalog = await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: {
      MIKKA_EDITION: 'cloud',
      STRIPE_SECRET_KEY: 'sk_test_catalog',
      STRIPE_TEAM_RESOURCE_PRICE_ID: 'price_team_1',
    },
    fetchImpl: seatFetch,
    bypassCache: true,
  })
  const team = catalog.plans.find((plan) => plan.plan === 'pro')
  assert.ok(team)
  assert.equal(team.id, 'team')
  assert.equal(team.active, true)
  assert.equal(team.seatModel, 'per_seat')
  assert.equal(team.includedPoints, 3000)
  assert.equal(team.amountCents, 3000)
})

test('catalog resolves Pro, Team, and Enterprise resource prices concurrently and scopes offers by plan id', async () => {
  const multiFetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/v1/prices/price_pro_multi')) {
      return Response.json({
        id: 'price_pro_multi',
        active: true,
        currency: 'usd',
        type: 'recurring',
        billing_scheme: 'per_unit',
        unit_amount: 2000,
        recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
        metadata: { mikka_billing_model: 'resource_v1', mikka_plan: 'pro', mikka_pricing_model: 'at_cost_v1', mikka_seat_model: 'per_workspace' },
      })
    }
    if (url.endsWith('/v1/prices/price_team_multi')) {
      return Response.json({
        id: 'price_team_multi',
        active: true,
        currency: 'usd',
        type: 'recurring',
        billing_scheme: 'per_unit',
        unit_amount: 2500,
        recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
        metadata: { mikka_billing_model: 'resource_v1', mikka_plan: 'pro', mikka_pricing_model: 'at_cost_v1', mikka_seat_model: 'per_seat' },
      })
    }
    if (url.endsWith('/v1/prices/price_ent_multi')) {
      return Response.json({
        id: 'price_ent_multi',
        active: true,
        currency: 'usd',
        type: 'recurring',
        billing_scheme: 'per_unit',
        unit_amount: 6000,
        recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
        metadata: { mikka_billing_model: 'resource_v1', mikka_plan: 'enterprise', mikka_pricing_model: 'at_cost_v1', mikka_seat_model: 'per_seat' },
      })
    }
    if (new URL(url).pathname === '/v1/coupons/coupon_pro_50') {
      return Response.json({
        id: 'coupon_pro_50',
        valid: true,
        duration: 'once',
        percent_off: 50,
      })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch

  const catalog = await resolveBillingCatalog({
    workspaceId: WORKSPACE_ID,
    env: {
      MIKKA_EDITION: 'cloud',
      STRIPE_SECRET_KEY: 'sk_test_catalog',
      STRIPE_PRO_RESOURCE_PRICE_ID: 'price_pro_multi',
      STRIPE_TEAM_RESOURCE_PRICE_ID: 'price_team_multi',
      STRIPE_ENTERPRISE_RESOURCE_PRICE_ID: 'price_ent_multi',
    },
    fetchImpl: multiFetch,
    now: Date.parse('2026-11-28T00:00:00.000Z'),
    activeOfferOverride: {
      id: 'pro-launch-50',
      kind: 'intro_period',
      planId: 'pro',
      introAmountCents: 1000,
      introInterval: 'month',
      regularAmountCents: 2000,
      regularInterval: 'month',
      introCreditCents: 1000,
      stripeCouponId: 'coupon_pro_50',
      endAt: '2026-12-05T00:00:00.000Z',
    },
    checkOfferEligibility: () => true,
    bypassCache: true,
  })

  assert.deepEqual(
    catalog.plans.map(p => ({ id: p.id, plan: p.plan, stripePriceId: p.stripePriceId, seatModel: p.seatModel, amountCents: p.amountCents })),
    [
      { id: 'pro', plan: 'pro', stripePriceId: 'price_pro_multi', seatModel: 'per_workspace', amountCents: 2000 },
      { id: 'team', plan: 'pro', stripePriceId: 'price_team_multi', seatModel: 'per_seat', amountCents: 2500 },
      { id: 'enterprise', plan: 'enterprise', stripePriceId: 'price_ent_multi', seatModel: 'per_seat', amountCents: 6000 },
    ],
  )
  assert.equal(catalog.activeOffer?.planId, 'pro')
  assert.equal(catalog.activeOffer?.introAmountCents, 1000)
})

test('intro offers match plan.id strictly and never apply to per_seat plans', async () => {
  const teamOnlyFetch = (async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input)).pathname
    if (pathname === '/v1/prices/price_team_only') {
      return Response.json({
        id: 'price_team_only',
        active: true,
        currency: 'usd',
        type: 'recurring',
        billing_scheme: 'per_unit',
        unit_amount: 2000,
        recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
        metadata: { mikka_billing_model: 'resource_v1', mikka_plan: 'pro', mikka_pricing_model: 'at_cost_v1', mikka_seat_model: 'per_seat' },
      })
    }
    if (pathname === '/v1/coupons/coupon_50') {
      return Response.json({ id: 'coupon_50', valid: true, duration: 'once', percent_off: 50 })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch

  for (const offerPlanId of ['pro', 'team']) {
    const catalog = await resolveBillingCatalog({
      workspaceId: WORKSPACE_ID,
      env: {
        MIKKA_EDITION: 'cloud',
        STRIPE_SECRET_KEY: 'sk_test_catalog',
        STRIPE_TEAM_RESOURCE_PRICE_ID: 'price_team_only',
      },
      fetchImpl: teamOnlyFetch,
      now: Date.parse('2026-11-28T00:00:00.000Z'),
      activeOfferOverride: {
        id: `offer-${offerPlanId}-50`,
        kind: 'intro_period',
        planId: offerPlanId,
        introAmountCents: 1000,
        introInterval: 'month',
        regularAmountCents: 2000,
        regularInterval: 'month',
        introCreditCents: 1000,
        stripeCouponId: 'coupon_50',
        endAt: '2026-12-05T00:00:00.000Z',
      },
      checkOfferEligibility: () => true,
      bypassCache: true,
    })
    assert.equal(catalog.plans.length, 1)
    assert.equal(catalog.plans[0].id, 'team')
    assert.equal(catalog.plans[0].seatModel, 'per_seat')
    assert.equal(catalog.activeOffer, null, `offer for ${offerPlanId} must never apply to a per_seat team plan`)
  }
})
