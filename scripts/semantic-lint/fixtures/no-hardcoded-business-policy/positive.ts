// Positive fixture for no-hardcoded-business-policy: every constant below should be flagged.

export const TRIAL_DAYS = 14
export const FREE_TRIAL_DURATION_MS = 14 * 24 * 60 * 60 * 1000
export const DISCOUNT_PERCENT = 20
export const PLAN_PRICE_MONTHLY_CENTS = 2000
export const INTRO_PRICE_LABEL = '$15/mo'
export const PROMO_END_AT = '2026-12-31T23:59:59Z'
export const CAMPAIGN_START_AT = new Date('2026-11-01T00:00:00Z')
export const FREE_PLAN_LIMIT = 5
export const PRO_PLAN_LIMIT = 50
export const MAX_FREE_WORKSPACES = 3

export const INLINE_OFFER_POLICY = {
  trialDays: 14,
  discountRate: 0.25,
  offerEndAt: '2026-12-31',
  monthlyPrice: '$20/mo',
}

export const annualPrice = 200
export const MONTHLY_PRICE = 2000

export class LegacyBillingDefaults {
  static readonly GRACE_PERIOD_DAYS = 7
}
