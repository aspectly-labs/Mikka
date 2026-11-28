export const POINTS_PURCHASE_AMOUNTS = [5, 10, 25, 50] as const

/** Purchased top-up credits expire 12 months after purchase (#3328). */
export const TOPUP_EXPIRY_MONTHS = 12

/** Computes the UTC expiration timestamp 12 calendar months after purchase, clamping leap-day dates. */
export function purchasedGrantExpiresAt(purchasedAt: Date): Date {
  const totalMonths = purchasedAt.getUTCFullYear() * 12 + purchasedAt.getUTCMonth() + TOPUP_EXPIRY_MONTHS
  const year = Math.floor(totalMonths / 12)
  const month = totalMonths % 12
  const maxDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const day = Math.min(purchasedAt.getUTCDate(), maxDay)
  return new Date(Date.UTC(
    year,
    month,
    day,
    purchasedAt.getUTCHours(),
    purchasedAt.getUTCMinutes(),
    purchasedAt.getUTCSeconds(),
    purchasedAt.getUTCMilliseconds(),
  ))
}
