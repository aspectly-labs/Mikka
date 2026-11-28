import 'server-only'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { db } from '@/lib/db'
import { billingEntitlementOutbox, workspaceBilling, workspaceCreditGrants } from '@/lib/db/schema'
import { hostedBillingChanged } from '@/lib/live/billing'
import { BILLING_LIVE_STATUSES } from '@/lib/workspace-admin/general'
import { resourcePrice, subscriptionEntitlement, RESOURCE_BILLING_VERSION } from './resource-plan'
import { POINTS_PER_USD, pointsToCreditCents } from './hosted-usage'
import { configuredResourcePriceIds, stripeConfig, stripeGet } from './stripe'
import type { PointsWebhookOptions } from './points-webhook'
import { invoiceFullyRefunded, invoicePaymentAllocations, reconcilePlanRefunds } from './plan-refunds'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
const stripeId = z.string().regex(/^[a-z]+_[A-Za-z0-9_]+$/)
const expandableId = z.union([stripeId, z.object({ id: stripeId })]).transform(value => typeof value === 'string' ? value : value.id)
const subscriptionSchema = z.object({
  id: stripeId, customer: expandableId, status: z.string(),
  metadata: z.object({ workspaceId: z.uuid(), billingModel: z.string().optional() }).loose(),
  current_period_end: z.number().int().positive().optional(),
  latest_invoice: z.union([stripeId, z.record(z.string(), z.unknown())]).nullish(),
  items: z.object({ data: z.array(z.object({ quantity: z.number().int().nonnegative().optional(),
    current_period_end: z.number().int().positive().optional(),
    price: z.object({ id: stripeId, nickname: z.string().nullish(), lookup_key: z.string().nullish() }).loose(),
  }).loose()) }).loose(),
}).loose()
const invoiceSchema = z.object({ id: stripeId, customer: expandableId, status: z.string().nullable(), amount_paid: z.number().int().nonnegative(),
  total_excluding_tax: z.number().int().nullish(),
  subtotal_excluding_tax: z.number().int().nullish(),
  payment_intent: expandableId.nullish(),
  currency: z.string(), billing_reason: z.string().nullable(), hosted_invoice_url: z.url().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  lines: z.object({ has_more: z.boolean(), data: z.array(z.object({
    price: z.object({ id: stripeId }).loose().nullish(),
    pricing: z.object({ price_details: z.object({ price: expandableId }).loose().nullish() }).loose().nullish(),
    proration: z.boolean().optional(),
    amount: z.number().int().optional(),
    amount_excluding_tax: z.number().int().nullish(),
    parent: z.object({ subscription_item_details: z.object({ proration: z.boolean() }).loose().nullish() }).loose().nullish(),
    quantity: z.number().int().nullish(), period: z.object({ start: z.number().int().positive(), end: z.number().int().positive() }),
  }).loose()) }).loose(),
}).loose()
const subscriptionTypes = new Set(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.paused', 'customer.subscription.resumed'])
const invoiceTypes = new Set(['invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.marked_uncollectible', 'invoice.voided'])

function invoiceSubscription(object: Record<string, unknown>): string | null {
  const parsed = z.object({ subscription: expandableId.nullish(), parent: z.object({ subscription_details: z.object({ subscription: expandableId }).loose().nullish() }).loose().nullish() }).loose().parse(object)
  return parsed.subscription ?? parsed.parent?.subscription_details?.subscription ?? null
}

const introCreditCentsSchema = z.preprocess(
  value => (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value),
  z.number().int().nonnegative(),
)

function normalizeIntroCreditCap(value: unknown): unknown {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed !== '' ? trimmed : undefined
  }
  return value
}

/**
 * Resolves the points granted for a paid subscription invoice.
 * Intro-offer initial invoices (`subscription_create`) carrying a validated
 * `mikka_intro_credit_cents` metadata cap grant at most that intro allowance;
 * renewals (`subscription_cycle`) always grant the full `monthlyPoints`.
 */
export function resolveSubscriptionGrantPoints(input: {
  billingReason: string | null | undefined
  monthlyPoints: number
  invoiceMetadata?: Record<string, unknown> | null
  subscriptionMetadata?: Record<string, unknown> | null
}): number {
  if (input.billingReason !== 'subscription_create') return input.monthlyPoints
  const rawCap = normalizeIntroCreditCap(input.invoiceMetadata?.mikka_intro_credit_cents)
    ?? normalizeIntroCreditCap(input.subscriptionMetadata?.mikka_intro_credit_cents)
  if (rawCap === undefined) return input.monthlyPoints
  const parsed = introCreditCentsSchema.safeParse(rawCap)
  if (!parsed.success || !Number.isSafeInteger(parsed.data)) throw new Error('billing_intro_credit_cap_invalid')
  const introCreditCents = parsed.data
  const maxCentsEquivalent = pointsToCreditCents(input.monthlyPoints)
  if (introCreditCents > maxCentsEquivalent) throw new Error('billing_intro_credit_cap_invalid')
  return Math.min(input.monthlyPoints, Math.floor((introCreditCents * POINTS_PER_USD) / 100))
}

/** Canonical Stripe reads occur under the account lock, so event arrival order cannot restore an old plan. */
export async function applySubscriptionEvent(tx: Transaction, event: { id: string; type: string; data: { object: Record<string, unknown> } }, options: PointsWebhookOptions) {
  if (!subscriptionTypes.has(event.type) && !invoiceTypes.has(event.type)) return
  const object = event.data.object
  const id = subscriptionTypes.has(event.type) ? stripeId.parse(object.id) : invoiceSubscription(object)
  if (!id) return // A one-off invoice does not provision a plan.
  const config = stripeConfig(options.env)
  if (!config) throw new Error('billing_webhook_configuration_unavailable')
  const get = (path: string) => stripeGet<unknown>(config, path, options.fetchImpl)
  const readSubscription = async (subscriptionId: string) => subscriptionSchema.parse(await get(`subscriptions/${subscriptionId}?expand%5B%5D=latest_invoice`))
  const [known] = await tx.select({ workspaceId: workspaceBilling.workspaceId }).from(workspaceBilling).where(eq(workspaceBilling.stripeSubscriptionId, id)).limit(1)
  const hint = z.object({ workspaceId: z.uuid() }).safeParse(object.metadata)
  const workspaceId = known?.workspaceId ?? (hint.success ? hint.data.workspaceId : (await readSubscription(id)).metadata.workspaceId)
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${workspaceId}`},0))`)
  const sub = await readSubscription(id)
  if (sub.id !== id || sub.metadata.workspaceId !== workspaceId) throw new Error('billing_subscription_scope_mismatch')
  const [previous] = await tx.select().from(workspaceBilling).where(eq(workspaceBilling.workspaceId, workspaceId)).for('update').limit(1)
  if (previous?.stripeCustomerId && previous.stripeCustomerId !== sub.customer) throw new Error('billing_customer_scope_mismatch')
  if (previous?.stripeSubscriptionId && previous.stripeSubscriptionId !== id) {
    // Late cancellation/invoice events for an old subscription cannot replace a
    // newer subscription. Also reject a second live subscription for one account.
    if (!(BILLING_LIVE_STATUSES as readonly string[]).includes(sub.status)) return
    const current = await readSubscription(previous.stripeSubscriptionId)
    if ((BILLING_LIVE_STATUSES as readonly string[]).includes(current.status)) throw new Error('billing_multiple_live_subscriptions')
  }
  const item = sub.items.data[0]
  const priceId = item?.price.id ?? null
  let approved: ReturnType<typeof resourcePrice> | null = null
  let plan: 'pro' | 'enterprise' | null = null
  let billingModel: 'legacy_seat' | 'resource_v1' = 'legacy_seat'
  if (priceId && configuredResourcePriceIds(config).includes(priceId)) {
    approved = resourcePrice(await get(`prices/${priceId}`), priceId, { requireActive: false })
    const validQty = approved.seatModel === 'per_seat'
      ? Number.isSafeInteger(item?.quantity) && (item?.quantity ?? 0) >= 1
      : item?.quantity === 1
    if (sub.items.data.length !== 1 || !validQty || sub.metadata.billingModel !== RESOURCE_BILLING_VERSION) throw new Error('billing_resource_subscription_invalid')
    plan = approved.plan; billingModel = RESOURCE_BILLING_VERSION
  } else if (priceId && priceId === config.teamPriceId && sub.items.data.length === 1) plan = 'pro'
  else if (priceId && priceId === previous?.stripePriceId && previous.billingPlan !== 'free') throw new Error('billing_plan_configuration_unavailable')
  const latest = typeof sub.latest_invoice === 'string' ? await get(`invoices/${sub.latest_invoice}`) : sub.latest_invoice
  const latestInvoice = invoiceSchema.safeParse(latest)
  if (latest != null && !latestInvoice.success && plan) throw new Error('billing_invoice_shape_invalid', { cause: latestInvoice.error })
  if (latestInvoice.success && (latestInvoice.data.customer !== sub.customer || invoiceSubscription(latestInvoice.data) !== sub.id)) throw new Error('billing_invoice_subscription_mismatch')
  const refunded = latestInvoice.success && await invoiceFullyRefunded(tx, latestInvoice.data.id)
  const paidLine = latestInvoice.success && latestInvoice.data.status === 'paid' && !refunded
    ? latestInvoice.data.lines.data.find(line => (line.price?.id ?? line.pricing?.price_details?.price) === priceId) : null
  const periodEnd = item?.current_period_end ?? sub.current_period_end ?? null
  const entitlement = subscriptionEntitlement({ status: sub.status, paid: Boolean(paidLine), plan,
    periodEnd: paidLine && periodEnd ? Math.min(paidLine.period.end, periodEnd) : null,
    previousPaidUntil: !refunded && previous?.billingPlan === plan ? previous.billingExpiresAt : null })
  const revision = (previous?.billingRevision ?? 0) + 1
  if (!Number.isSafeInteger(revision)) throw new Error('billing_revision_overflow')
  const values = { stripeCustomerId: sub.customer, stripeSubscriptionId: id, stripePriceId: priceId,
    status: sub.status, plan: item?.price.nickname ?? item?.price.lookup_key ?? plan ?? 'Unknown',
    seats: item?.quantity ?? 0, billingModel, billingPlan: entitlement.plan, billingExpiresAt: entitlement.expiresAt,
    billingRevision: revision, billingInvoiceId: latestInvoice.success ? latestInvoice.data.id : null,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null, updatedAt: new Date() }
  await tx.insert(workspaceBilling).values({ workspaceId, ...values }).onConflictDoUpdate({ target: workspaceBilling.workspaceId, set: values })
  await tx.insert(billingEntitlementOutbox).values({ eventId: event.id, workspaceId, subscriptionId: id, plan: entitlement.plan,
    expiresAt: entitlement.expiresAt, revision, billingModel })
  if (approved) {
    // A late paid invoice still gets its own historical receipt, even when the
    // subscription has since renewed/canceled. Expiry prevents old points revival.
    const candidate = invoiceTypes.has(event.type) ? await get(`invoices/${stripeId.parse(object.id)}`) : latest
    const invoice = invoiceSchema.safeParse(candidate)
    if (candidate != null && !invoice.success) throw new Error('billing_invoice_shape_invalid', { cause: invoice.error })
    const grantPlanInvoice = async (
      invoiceData: z.infer<typeof invoiceSchema>,
      grantPoints: number,
      periodStart: number,
      periodEnd: number,
    ) => {
      const [existing] = await tx.select().from(workspaceCreditGrants).where(eq(workspaceCreditGrants.externalId, `invoice:${invoiceData.id}`)).limit(1)
      if (existing && (existing.workspaceId !== workspaceId || existing.stripeInvoiceId !== invoiceData.id
        || existing.bucket !== 'plan' || existing.reason !== 'subscription')) throw new Error('billing_invoice_grant_scope_mismatch')
      const paymentAllocations = existing?.paymentAllocations ?? await invoicePaymentAllocations(invoiceData, get)
      const granted = await tx.insert(workspaceCreditGrants).values({ id: randomUUID(), workspaceId, bucket: 'plan', points: grantPoints,
        reason: 'subscription', externalId: `invoice:${invoiceData.id}`, amountCents: invoiceData.amount_paid, currency: 'usd',
        stripeInvoiceId: invoiceData.id, paymentAllocations,
        stripePaymentIntentId: Object.keys(paymentAllocations).length === 1 ? Object.keys(paymentAllocations)[0] : null,
        receiptUrl: invoiceData.hosted_invoice_url ?? null, periodStart: new Date(periodStart * 1000), expiresAt: new Date(periodEnd * 1000),
      }).onConflictDoNothing({ target: workspaceCreditGrants.externalId }).returning()
      const grant = existing ?? granted[0]
      if (!grant) throw new Error('billing_invoice_grant_missing')
      await reconcilePlanRefunds(tx, event.id, grant)
    }

    if (invoice.success && invoice.data.status === 'paid' && invoice.data.currency === 'usd'
      && ['subscription_create', 'subscription_cycle'].includes(invoice.data.billing_reason ?? '')) {
      if (invoice.data.customer !== sub.customer || invoiceSubscription(invoice.data) !== sub.id) throw new Error('billing_invoice_subscription_mismatch')
      if (invoice.data.lines.has_more) throw new Error('billing_resource_invoice_lines_incomplete')
      const lines = invoice.data.lines.data.filter(line => (line.price?.id ?? line.pricing?.price_details?.price) === approved.id
        && !(line.proration ?? line.parent?.subscription_item_details?.proration ?? false)
        && (approved.seatModel === 'per_seat' ? (line.quantity ?? 0) >= 1 : line.quantity === 1))
      if (lines.length !== 1 || lines[0].period.end <= lines[0].period.start) throw new Error('billing_resource_invoice_period_invalid')
      const period = lines[0].period
      const lineSeats = approved.seatModel === 'per_seat' ? (lines[0].quantity ?? 1) : 1
      const grantPoints = resolveSubscriptionGrantPoints({
        billingReason: invoice.data.billing_reason,
        monthlyPoints: approved.monthlyPoints * lineSeats,
        invoiceMetadata: invoice.data.metadata,
        subscriptionMetadata: sub.metadata,
      })
      await grantPlanInvoice(invoice.data, grantPoints, period.start, period.end)
    } else if (invoice.success && invoice.data.status === 'paid' && invoice.data.currency === 'usd'
      && approved.seatModel === 'per_seat'
      && invoice.data.billing_reason === 'subscription_update'
      && invoice.data.amount_paid > 0) {
      if (invoice.data.customer !== sub.customer || invoiceSubscription(invoice.data) !== sub.id) throw new Error('billing_invoice_subscription_mismatch')
      if (invoice.data.lines.has_more) throw new Error('billing_resource_invoice_lines_incomplete')
      const prorationLines = invoice.data.lines.data.filter(line => (line.price?.id ?? line.pricing?.price_details?.price) === approved.id && line.period.end > line.period.start)
      if (!prorationLines.length) throw new Error('billing_resource_invoice_period_invalid')
      const periodStart = Math.min(...prorationLines.map(line => line.period.start))
      const periodEnd = Math.max(...prorationLines.map(line => line.period.end))
      const hasPreTaxLines = prorationLines.some(line => line.amount_excluding_tax != null || line.amount != null)
      const linesNetCents = hasPreTaxLines
        ? Math.max(0, prorationLines.reduce((sum, line) => sum + (line.amount_excluding_tax ?? line.amount ?? 0), 0))
        : null
      const preTaxCap = Math.max(0, invoice.data.total_excluding_tax ?? invoice.data.subtotal_excluding_tax ?? invoice.data.amount_paid)
      const netCents = linesNetCents !== null ? Math.min(linesNetCents, preTaxCap) : preTaxCap
      const grantPoints = Math.floor((netCents * POINTS_PER_USD) / 100)
      if (grantPoints > 0) {
        await grantPlanInvoice(invoice.data, grantPoints, periodStart, periodEnd)
      }
    }
  }
  await hostedBillingChanged(tx, workspaceId)
}
