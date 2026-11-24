import { basePath } from '../lib/base-path-config.mjs'

/**
 * The cookie that remembers a person's explicit language choice. It follows
 * the product's other cookie, `mikka-workspace`: lower case, `mikka-` prefix.
 * Every writer (the page response and the client locale switch) writes only
 * this name, with the attributes `localeCookie` gives.
 */
export const LOCALE_COOKIE = 'mikka-locale'

/**
 * The same cookie's name from before Next.js was retired
 * (docs/design/decisions/2026-11-18-1500-retire-next-dependency.md).
 *
 * Read only to migrate people who chose a language before the rename: a page
 * document re-issues their choice as `LOCALE_COOKIE` and expires this one, so
 * one visit migrates them. Nothing writes it. The old cookie lived for one
 * year (Max-Age 31536000), so on or after 2027-11-24 no browser can still
 * hold one: delete this constant, `EXPIRED_LEGACY_LOCALE_COOKIE` and the
 * legacy fallback in `storedLocale` then, and drop the exception in
 * scripts/next-free-locale.test.mjs.
 */
export const LEGACY_LOCALE_COOKIE = 'NEXT_LOCALE'

/** One year, the lifetime the cookie has always had. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/** @typedef {'zh-CN' | 'en'} StoredLocale */

/** @param {string | undefined} value @returns {value is StoredLocale} */
const supported = value => value === 'zh-CN' || value === 'en'

/**
 * The person's stored choice: the new cookie when it names a supported
 * locale, otherwise the legacy cookie when it does, otherwise none. `read`
 * returns a cookie's parsed value (the last well-formed one, already decoded).
 * @param {(name: string) => string | undefined} read
 * @returns {StoredLocale | undefined}
 */
export function storedLocale(read) {
  const current = read(LOCALE_COOKIE)
  if (supported(current)) return current
  const legacy = read(LEGACY_LOCALE_COOKIE)
  return supported(legacy) ? legacy : undefined
}

/**
 * The Set-Cookie value (or `document.cookie` assignment) for a choice.
 * @param {string} locale
 * @param {string} [path]
 */
export function localeCookie(locale, path = basePath) {
  return `${LOCALE_COOKIE}=${locale}; Max-Age=${LOCALE_COOKIE_MAX_AGE}; Path=${path || '/'}; SameSite=Lax`
}

/** Expires the legacy cookie with the attributes it was written with. */
export const EXPIRED_LEGACY_LOCALE_COOKIE = `${LEGACY_LOCALE_COOKIE}=; Max-Age=0; Path=${basePath}; SameSite=Lax`
