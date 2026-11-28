import { z } from 'zod'

/** A price is approved for resource billing explicitly, never by its nickname. */
export const RESOURCE_BILLING_VERSION = 'resource_v1' as const
export const resourcePriceSchema = z.object({
  id: z.string().regex(/^price_[A-Za-z0-9_]+$/), active: z.boolean(), currency: z.literal('usd'),
  type: z.literal('recurring'), billing_scheme: z.literal('per_unit'),
  unit_amount: z.number().int().positive(),
  recurring: z.object({ interval: z.literal('month'), interval_count: z.literal(1), usage_type: z.literal('licensed') }),
  metadata: z.object({
    mikka_billing_model: z.literal(RESOURCE_BILLING_VERSION),
    mikka_plan: z.enum(['pro', 'enterprise']),
    mikka_monthly_points: z.string().regex(/^\d+$/).transform(Number).refine(value => Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000).optional(),
    mikka_seat_model: z.enum(['per_workspace', 'per_seat']).optional(),
    mikka_pricing_model: z.enum(['at_cost_v1']).optional(),
  }).loose(),
}).loose()

/** The configured ID and Stripe-owned product metadata must both agree. */
export function resourcePrice(raw: unknown, configuredId: string, options: { requireActive?: boolean } = {}) {
  const price = resourcePriceSchema.parse(raw)
  if (price.id !== configuredId || (options.requireActive !== false && !price.active)) throw new Error('billing_resource_price_invalid')
  const monthlyPoints = price.metadata.mikka_monthly_points ?? price.unit_amount
  if (price.metadata.mikka_pricing_model === 'at_cost_v1' && monthlyPoints !== price.unit_amount) {
    throw new Error('billing_resource_price_invalid')
  }
  const seatModel = price.metadata.mikka_seat_model ?? 'per_workspace'
  return { id: price.id, plan: price.metadata.mikka_plan, monthlyPoints, seatModel,
    amountCents: price.unit_amount, currency: price.currency, version: RESOURCE_BILLING_VERSION }
}

export interface BillingEntitlementProjection {
  workspaceId: string
  subscriptionId: string
  plan: 'free' | 'pro' | 'enterprise'
  expiresAt: string | null
  revision: number
  eventId: string
  billingModel: 'legacy_seat' | 'resource_v1'
}

/** Paid access never becomes perpetual because Stripe omitted a period. */
export function subscriptionEntitlement(input: {
  status: string; paid: boolean; plan: 'pro' | 'enterprise' | null;
  periodEnd: number | null; previousPaidUntil?: Date | null; now?: Date;
}) {
  const now = (input.now ?? new Date()).getTime()
  const paidUntil = input.status === 'active' && input.paid && input.periodEnd
    ? new Date(input.periodEnd * 1000)
    : input.status === 'past_due' || input.status === 'active' ? input.previousPaidUntil ?? null : null
  return input.plan && paidUntil && paidUntil.getTime() > now
    ? { plan: input.plan, expiresAt: paidUntil }
    : { plan: 'free' as const, expiresAt: null }
}
