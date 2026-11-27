import { analyticsPath } from './analytics-path.ts'

/** Non-identifying first-touch attribution shared by marketing and App subdomains.
 * Cookie values are untrusted analytics hints, never authorization inputs.
 * Keep this contract identical in both repositories (mirrors
 * mikka-web/lib/first-touch.mjs).
 */
export const FIRST_TOUCH_COOKIE = 'mikka_first_touch_v1'
export const FIRST_TOUCH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

export const safeLabel = (value: unknown) =>
  typeof value === 'string' && value.length > 0 && value.length <= 80 && /^[a-z0-9][a-z0-9._-]*$/i.test(value)
    ? value.toLowerCase() : null

export const safeDomain = (value: unknown) =>
  typeof value === 'string' && value.length <= 253 && /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(value)
    ? value.toLowerCase() : null

export function safeLanding(pathname: unknown) {
  if (typeof pathname !== 'string' || pathname === '/') return '/'
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length > 4 || segments.some(part => !/^[a-z][a-z0-9-]{0,32}$/i.test(part))) return '/'
  if (segments.some(part => ['invite', 'organization-invite', 'share', 'shared', 'token', 'oauth', 'callback', 'reset-password', 'device', 'settings', 'w', 'a'].includes(part.toLowerCase()))) return '/'
  const landing = '/' + segments.join('/')
  // Stricter than the marketing site's copy, never looser: a path analytics would
  // rewrite (an id, a token, a page that carries one) is not a landing page.
  return analyticsPath(landing) === landing ? landing : '/'
}

export interface FirstTouch {
  v: 1
  source: string
  acquired_at: number
  landing_path: string
  referrer_domain?: string
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  utm_content?: string
  utm_term?: string
}

/** Accepts only known, bounded, non-sensitive fields. */
export function parseFirstTouch(cookieHeader: string | null | undefined, now = Date.now()): FirstTouch | null {
  if (typeof cookieHeader !== 'string') return null
  const segment = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith(FIRST_TOUCH_COOKIE + '='))
  if (!segment) return null
  try {
    const value = JSON.parse(decodeURIComponent(segment.slice(FIRST_TOUCH_COOKIE.length + 1)))
    if (value.v !== 1 || typeof value.acquired_at !== 'number' || !Number.isFinite(value.acquired_at)
      || value.acquired_at > now || now - value.acquired_at > FIRST_TOUCH_MAX_AGE_SECONDS * 1000) return null
    const source = safeLabel(value.source)
    const landing_path = typeof value.landing_path === 'string' ? safeLanding(value.landing_path) : '/'
    if (!source) return null
    return {
      v: 1, source, acquired_at: value.acquired_at, landing_path,
      ...(safeDomain(value.referrer_domain) ? { referrer_domain: safeDomain(value.referrer_domain)! } : {}),
      ...Object.fromEntries((['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const)
        .filter(key => safeLabel(value[key])).map(key => [key, safeLabel(value[key])])),
    }
  } catch { return null }
}

/** The acquisition fields an event may carry, in PostHog property names. */
export function firstTouchProperties(touch: FirstTouch | null): Record<string, string> {
  if (!touch) return { first_touch_source: 'direct_or_unknown' }
  const out: Record<string, string> = { first_touch_source: touch.source, first_touch_landing: touch.landing_path }
  if (touch.referrer_domain) out.first_touch_referrer_domain = touch.referrer_domain
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const)
    if (touch[key]) out[`first_touch_${key}`] = touch[key]
  return out
}
