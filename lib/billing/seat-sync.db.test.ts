import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'

type StripeRequestRecord = { method: string; path: string; body: URLSearchParams | null }

const PRICE_PRO = 'price_res_pro_multi'
const PRICE_TEAM = 'price_res_team_multi'
const PRICE_ENT = 'price_res_ent_multi'

const STRIPE_PRICES: Record<string, Record<string, unknown>> = {
  [PRICE_PRO]: {
    id: PRICE_PRO,
    active: true,
    currency: 'usd',
    type: 'recurring',
    billing_scheme: 'per_unit',
    unit_amount: 2000,
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    metadata: { mikka_billing_model: 'resource_v1', mikka_plan: 'pro', mikka_pricing_model: 'at_cost_v1', mikka_seat_model: 'per_workspace' },
  },
  [PRICE_TEAM]: {
    id: PRICE_TEAM,
    active: true,
    currency: 'usd',
    type: 'recurring',
    billing_scheme: 'per_unit',
    unit_amount: 2500,
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    metadata: { mikka_billing_model: 'resource_v1', mikka_plan: 'pro', mikka_pricing_model: 'at_cost_v1', mikka_seat_model: 'per_seat' },
  },
  [PRICE_ENT]: {
    id: PRICE_ENT,
    active: true,
    currency: 'usd',
    type: 'recurring',
    billing_scheme: 'per_unit',
    unit_amount: 6000,
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    metadata: { mikka_billing_model: 'resource_v1', mikka_plan: 'enterprise', mikka_pricing_model: 'at_cost_v1', mikka_seat_model: 'per_seat' },
  },
}

const TEST_ENV = {
  MIKKA_EDITION: 'cloud',
  BETTER_AUTH_URL: 'https://mikka.test',
  MIKKA_APP_ORIGIN: 'https://mikka.test',
  STRIPE_SECRET_KEY: 'sk_test_multi_plan_seat_sync',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_multi_plan_seat_sync',
  STRIPE_PRO_RESOURCE_PRICE_ID: PRICE_PRO,
  STRIPE_TEAM_RESOURCE_PRICE_ID: PRICE_TEAM,
  STRIPE_ENTERPRISE_RESOURCE_PRICE_ID: PRICE_ENT,
}

test('multi-plan Stripe checkout/webhooks, org per_seat quantity, and event-driven seat synchronization', { skip: !dbUrl }, async t => {
  const fixture = new Pool({ connectionString: dbUrl })
  t.after(() => fixture.end())

  const { pool } = await import('@/lib/db')
  const { workspacePool } = await import('@/lib/workspace-db')
  t.after(() => Promise.allSettled([pool.end(), workspacePool.end()]))

  const { applyStripeEvent, planCheckoutUrl } = await import('./service')
  const { activeSeatCountForBillingAccount, syncPerSeatSubscriptionForOrganization, syncPerSeatSubscriptionForWorkspace, syncPerSeatSubscriptionQuantity } = await import('./seat-sync')
  const { createOrganization, attachOrganizationWorkspace, addOrganizationMember, removeOrganizationMember } = await import('@/lib/governance/organizations')
  const { setOrganizationBillingAccount } = await import('./organization-account')
  const { removeMember } = await import('@/lib/workspace-admin/members')

  const makeMockStripe = (options: {
    subscriptions?: Map<string, { id: string; customer: string; status: string; workspaceId: string; priceId: string; itemId: string; quantity: number }>
    failItemUpdate?: boolean
  } = {}) => {
    const requests: StripeRequestRecord[] = []
    const subscriptions = options.subscriptions ?? new Map()
    let sessionSeq = 0
    let customerSeq = 0

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace(/^\/v1\//, '')
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? new URLSearchParams(init.body) : null
      requests.push({ method, path, body })

      if (method === 'GET' && path.startsWith('prices/')) {
        const priceId = decodeURIComponent(path.slice('prices/'.length))
        const price = STRIPE_PRICES[priceId]
        return price ? Response.json(price) : Response.json({ error: 'not_found' }, { status: 404 })
      }
      if (method === 'POST' && path === 'customers') {
        customerSeq += 1
        return Response.json({ id: `cus_multi_${customerSeq}_${randomUUID().slice(0, 8)}` })
      }
      if (method === 'GET' && path === 'subscriptions') {
        return Response.json({ has_more: false, data: [] })
      }
      if (method === 'POST' && path === 'checkout/sessions') {
        sessionSeq += 1
        return Response.json({
          id: `cs_multi_${sessionSeq}_${randomUUID().slice(0, 8)}`,
          mode: 'subscription',
          status: 'open',
          customer: body?.get('customer'),
          client_reference_id: body?.get('client_reference_id'),
          metadata: {
            workspaceId: body?.get('metadata[workspaceId]') ?? '',
            billingModel: body?.get('metadata[billingModel]') ?? '',
            checkoutRequestId: body?.get('metadata[checkoutRequestId]') ?? '',
          },
          expires_at: Number(body?.get('expires_at')),
          url: `https://checkout.stripe.com/c/pay/cs_multi_${sessionSeq}`,
        })
      }
      if (method === 'GET' && path.startsWith('subscriptions/')) {
        const subId = decodeURIComponent(path.slice('subscriptions/'.length))
        const sub = subscriptions.get(subId)
        if (!sub) return Response.json({ error: 'not_found' }, { status: 404 })
        const nowSec = Math.floor(Date.now() / 1000)
        return Response.json({
          id: sub.id,
          customer: sub.customer,
          status: sub.status,
          current_period_end: nowSec + 30 * 86_400,
          metadata: { workspaceId: sub.workspaceId, billingModel: 'resource_v1' },
          items: {
            data: [{
              id: sub.itemId,
              quantity: sub.quantity,
              current_period_end: nowSec + 30 * 86_400,
              price: { id: sub.priceId, nickname: sub.priceId },
            }],
          },
          latest_invoice: {
            id: `in_${sub.id}`,
            customer: sub.customer,
            subscription: sub.id,
            status: 'paid',
            amount_paid: (STRIPE_PRICES[sub.priceId].unit_amount as number) * sub.quantity,
            currency: 'usd',
            billing_reason: 'subscription_create',
            payment_intent: `pi_${sub.id}`,
            lines: {
              has_more: false,
              data: [{
                price: { id: sub.priceId },
                quantity: sub.quantity,
                period: { start: nowSec - 60, end: nowSec + 30 * 86_400 },
              }],
            },
          },
        })
      }
      if (method === 'GET' && path.startsWith('payment_intents/')) {
        const piId = decodeURIComponent(path.slice('payment_intents/'.length))
        const subId = piId.startsWith('pi_') ? piId.slice(3) : ''
        const sub = subscriptions.get(subId)
        const amount = sub ? (STRIPE_PRICES[sub.priceId].unit_amount as number) * sub.quantity : 2000
        return Response.json({ id: piId, amount_received: amount, currency: 'usd', latest_charge: null })
      }
      if (method === 'GET' && path === 'invoice_payments') {
        return Response.json({ has_more: false, data: [] })
      }
      if (method === 'POST' && path.startsWith('subscription_items/')) {
        if (options.failItemUpdate) return Response.json({ error: 'stripe_unavailable' }, { status: 503 })
        const itemId = decodeURIComponent(path.slice('subscription_items/'.length))
        const nextQty = Number(body?.get('quantity'))
        for (const sub of subscriptions.values()) {
          if (sub.itemId === itemId) sub.quantity = nextQty
        }
        return Response.json({ id: itemId, quantity: nextQty })
      }
      return Response.json({ error: `unexpected ${method} ${path}` }, { status: 404 })
    }) as unknown as typeof fetch

    return { fetchImpl, requests, subscriptions }
  }

  // 1) Multi-plan Checkout + Webhook (Pro per_workspace, Enterprise per_seat, reject unconfigured price)
  await t.test('multi-plan Checkout selects requested price and webhooks grant entitlements for Pro and Enterprise', async () => {
    const ownerId = await seedUser(fixture, 'multi-plan-owner')
    const memberId = await seedUser(fixture, 'multi-plan-member')
    const proWs = await seedWorkspace(fixture, ownerId, [
      { userId: ownerId, role: 'admin' },
      { userId: memberId, role: 'member' },
    ])
    const entWs = await seedWorkspace(fixture, ownerId, [
      { userId: ownerId, role: 'admin' },
      { userId: memberId, role: 'member' },
    ])
    const stripe = makeMockStripe()

    await assert.rejects(
      () => planCheckoutUrl(ownerId, proWs.id, 'https://mikka.test/settings', stripe.fetchImpl, TEST_ENV, 'price_unknown_999'),
      { code: 'billingResourcePlanUnavailable' },
    )

    const proCheckout = await planCheckoutUrl(ownerId, proWs.id, 'https://mikka.test/settings', stripe.fetchImpl, TEST_ENV, PRICE_PRO)
    assert.ok(proCheckout.url.startsWith('https://checkout.stripe.com/'))
    const proSessionReq = stripe.requests.find(r => r.method === 'POST' && r.path === 'checkout/sessions' && r.body?.get('metadata[workspaceId]') === proWs.id)
    assert.equal(proSessionReq?.body?.get('line_items[0][price]'), PRICE_PRO)
    assert.equal(proSessionReq?.body?.get('line_items[0][quantity]'), '1')

    const entCheckout = await planCheckoutUrl(ownerId, entWs.id, 'https://mikka.test/settings', stripe.fetchImpl, TEST_ENV, PRICE_ENT)
    assert.ok(entCheckout.url.startsWith('https://checkout.stripe.com/'))
    const entSessionReq = stripe.requests.find(r => r.method === 'POST' && r.path === 'checkout/sessions' && r.body?.get('metadata[workspaceId]') === entWs.id)
    assert.equal(entSessionReq?.body?.get('line_items[0][price]'), PRICE_ENT)
    assert.equal(entSessionReq?.body?.get('line_items[0][quantity]'), '2')

    const proCustomer = (await fixture.query<{ stripeCustomerId: string }>('SELECT "stripeCustomerId" FROM workspace_billing WHERE "workspaceId"=$1', [proWs.id])).rows[0].stripeCustomerId
    const entCustomer = (await fixture.query<{ stripeCustomerId: string }>('SELECT "stripeCustomerId" FROM workspace_billing WHERE "workspaceId"=$1', [entWs.id])).rows[0].stripeCustomerId

    stripe.subscriptions.set('sub_pro_multi', {
      id: 'sub_pro_multi', customer: proCustomer, status: 'active', workspaceId: proWs.id,
      priceId: PRICE_PRO, itemId: 'si_pro_multi', quantity: 1,
    })
    stripe.subscriptions.set('sub_ent_multi', {
      id: 'sub_ent_multi', customer: entCustomer, status: 'active', workspaceId: entWs.id,
      priceId: PRICE_ENT, itemId: 'si_ent_multi', quantity: 2,
    })

    await applyStripeEvent(
      { id: `evt_${randomUUID()}`, type: 'customer.subscription.created', data: { object: { id: 'sub_pro_multi', metadata: { workspaceId: proWs.id } } } },
      { env: TEST_ENV, fetchImpl: stripe.fetchImpl },
    )
    await applyStripeEvent(
      { id: `evt_${randomUUID()}`, type: 'customer.subscription.created', data: { object: { id: 'sub_ent_multi', metadata: { workspaceId: entWs.id } } } },
      { env: TEST_ENV, fetchImpl: stripe.fetchImpl },
    )

    const { rows: [proRow] } = await fixture.query<{ billingPlan: string; seats: number; stripePriceId: string }>(
      'SELECT "billingPlan",seats,"stripePriceId" FROM workspace_billing WHERE "workspaceId"=$1',
      [proWs.id],
    )
    assert.deepEqual(proRow, { billingPlan: 'pro', seats: 1, stripePriceId: PRICE_PRO })

    const { rows: [entRow] } = await fixture.query<{ billingPlan: string; seats: number; stripePriceId: string }>(
      'SELECT "billingPlan",seats,"stripePriceId" FROM workspace_billing WHERE "workspaceId"=$1',
      [entWs.id],
    )
    assert.deepEqual(entRow, { billingPlan: 'enterprise', seats: 2, stripePriceId: PRICE_ENT })

    // per_workspace Pro plan is untouched by seat sync even with 2 active members.
    const proSync = await syncPerSeatSubscriptionQuantity(proWs.id, { env: TEST_ENV, fetchImpl: stripe.fetchImpl })
    assert.deepEqual(proSync, { synced: false, reason: 'not_per_seat' })
    assert.equal(stripe.requests.filter(r => r.method === 'POST' && r.path.startsWith('subscription_items/')).length, 0)
  })

  // 2) Organization per_seat Checkout counts active organizationMembers across attached workspaces
  //    and syncPerSeatSubscriptionForOrganization syncs adds/removals with exact proration behavior.
  await t.test('organization per_seat checkout and membership changes sync Stripe subscription seats', async () => {
    const ownerId = await seedUser(fixture, 'org-seat-owner')
    const memberA = await seedUser(fixture, 'org-seat-a')
    const memberB = await seedUser(fixture, 'org-seat-b')
    const memberC = await seedUser(fixture, 'org-seat-c')

    const billingWs = await seedWorkspace(fixture, ownerId, [{ userId: ownerId, role: 'admin' }])
    const engineeringWs = await seedWorkspace(fixture, ownerId, [
      { userId: ownerId, role: 'admin' },
      { userId: memberA, role: 'member' },
      { userId: memberB, role: 'member' },
    ])

    const org = await createOrganization(
      { id: ownerId, name: 'Org Owner', email: `org-owner-${ownerId}@example.com` },
      { name: `Seat Sync Org ${randomUUID().slice(0, 6)}` },
    )
    await attachOrganizationWorkspace(org.id, billingWs.id, ownerId)
    await attachOrganizationWorkspace(org.id, engineeringWs.id, ownerId)
    await addOrganizationMember(org.id, ownerId, { userId: memberA, role: 'member' })
    await addOrganizationMember(org.id, ownerId, { userId: memberB, role: 'member' })
    await setOrganizationBillingAccount(ownerId, org.id, billingWs.id)

    // Billing workspace itself has only 1 workspace member, while the Organization has 3 active members!
    const count = await activeSeatCountForBillingAccount(billingWs.id)
    assert.deepEqual(count, { scope: 'organization', organizationId: org.id, activeMembers: 3, seats: 3 })

    const stripe = makeMockStripe()
    await planCheckoutUrl(ownerId, billingWs.id, 'https://mikka.test/settings', stripe.fetchImpl, TEST_ENV, PRICE_TEAM)
    const sessionReq = stripe.requests.find(r => r.method === 'POST' && r.path === 'checkout/sessions')
    assert.equal(sessionReq?.body?.get('line_items[0][price]'), PRICE_TEAM)
    assert.equal(sessionReq?.body?.get('line_items[0][quantity]'), '3', 'Organization per_seat Checkout must bill all active Organization members')

    const customerId = (await fixture.query<{ stripeCustomerId: string }>('SELECT "stripeCustomerId" FROM workspace_billing WHERE "workspaceId"=$1', [billingWs.id])).rows[0].stripeCustomerId
    stripe.subscriptions.set('sub_org_team', {
      id: 'sub_org_team', customer: customerId, status: 'active', workspaceId: billingWs.id,
      priceId: PRICE_TEAM, itemId: 'si_org_team', quantity: 3,
    })
    await applyStripeEvent(
      { id: `evt_${randomUUID()}`, type: 'customer.subscription.created', data: { object: { id: 'sub_org_team', metadata: { workspaceId: billingWs.id } } } },
      { env: TEST_ENV, fetchImpl: stripe.fetchImpl },
    )

    // Add 4th active org member -> always_invoice on seat increase.
    await addOrganizationMember(org.id, ownerId, { userId: memberC, role: 'member' })
    await syncPerSeatSubscriptionForOrganization(org.id, { env: TEST_ENV, fetchImpl: stripe.fetchImpl })
    const increaseReq = stripe.requests.filter(r => r.method === 'POST' && r.path === 'subscription_items/si_org_team').at(-1)
    assert.equal(increaseReq?.body?.get('quantity'), '4')
    assert.equal(increaseReq?.body?.get('proration_behavior'), 'always_invoice')
    assert.equal((await fixture.query<{ seats: number }>('SELECT seats FROM workspace_billing WHERE "workspaceId"=$1', [billingWs.id])).rows[0].seats, 4)

    // Unchanged repeat sync is a zero-POST no-op.
    const postCountBefore = stripe.requests.filter(r => r.method === 'POST' && r.path === 'subscription_items/si_org_team').length
    const noop = await syncPerSeatSubscriptionQuantity(billingWs.id, { env: TEST_ENV, fetchImpl: stripe.fetchImpl })
    assert.deepEqual(noop, { synced: false, reason: 'unchanged', seats: 4 })
    assert.equal(stripe.requests.filter(r => r.method === 'POST' && r.path === 'subscription_items/si_org_team').length, postCountBefore)

    // Remove org member -> create_prorations on seat decrease.
    await removeOrganizationMember(org.id, ownerId, memberC)
    await syncPerSeatSubscriptionForOrganization(org.id, { env: TEST_ENV, fetchImpl: stripe.fetchImpl })
    const decreaseReq = stripe.requests.filter(r => r.method === 'POST' && r.path === 'subscription_items/si_org_team').at(-1)
    assert.equal(decreaseReq?.body?.get('quantity'), '3')
    assert.equal(decreaseReq?.body?.get('proration_behavior'), 'create_prorations')
    assert.equal((await fixture.query<{ seats: number }>('SELECT seats FROM workspace_billing WHERE "workspaceId"=$1', [billingWs.id])).rows[0].seats, 3)

    const audits = (await fixture.query<{ action: string; metadata: { previousSeats: number; seats: number; prorationBehavior: string } }>(
      `SELECT action,metadata FROM workspace_audit_events WHERE "workspaceId"=$1 AND action='billing.seats_synced' ORDER BY "createdAt" ASC`,
      [billingWs.id],
    )).rows
    assert.deepEqual(audits.map(row => row.metadata), [
      { previousSeats: 3, seats: 4, prorationBehavior: 'always_invoice' },
      { previousSeats: 4, seats: 3, prorationBehavior: 'create_prorations' },
    ])
  })

  // 3) Workspace removeMember commits cleanly even when Stripe is returning 503.
  await t.test('Stripe outage during per_seat sync never breaks workspace member removal', async () => {
    const ownerId = await seedUser(fixture, 'ws-seat-outage-owner')
    const memberId = await seedUser(fixture, 'ws-seat-outage-member')
    const ws = await seedWorkspace(fixture, ownerId, [
      { userId: ownerId, role: 'admin' },
      { userId: memberId, role: 'member' },
    ])
    const customerId = `cus_outage_${randomUUID().slice(0, 8)}`
    const stripe = makeMockStripe({ failItemUpdate: true })
    stripe.subscriptions.set('sub_ws_outage', {
      id: 'sub_ws_outage', customer: customerId, status: 'active', workspaceId: ws.id,
      priceId: PRICE_TEAM, itemId: 'si_ws_outage', quantity: 2,
    })
    await applyStripeEvent(
      { id: `evt_${randomUUID()}`, type: 'customer.subscription.created', data: { object: { id: 'sub_ws_outage', metadata: { workspaceId: ws.id } } } },
      { env: TEST_ENV, fetchImpl: stripe.fetchImpl },
    )

    // Remove member succeeds (with runtimeEnv unconfigured in default test env, and wrapper tolerates 503 explicitly).
    const removed = await removeMember(ownerId, ws.id, memberId)
    assert.equal(removed.removed, true)
    await assert.doesNotReject(() => syncPerSeatSubscriptionForWorkspace(ws.id, { env: TEST_ENV, fetchImpl: stripe.fetchImpl }))
    assert.equal((await activeSeatCountForBillingAccount(ws.id)).seats, 1)
  })
})
