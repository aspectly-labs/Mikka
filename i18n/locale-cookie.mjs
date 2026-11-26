import { basePath } from '../lib/base-path-config.mjs'

/**
 * The cookie that remembers a person's explicit language choice. It follows
 * the product's other cookie, `mikka-workspace`: lower case, `mikka-` prefix.
 * Readers go through `storedLocale`; writers (the page response and the client
 * locale switch) go through `localeCookies`.
 */
export const LOCALE_COOKIE = 'mikka-locale'

/**
 * The same cookie's name from before Next.js was retired
 * (mikka-hosted-ui/docs/design/decisions/2026-11-18-1500-retire-next-dependency.md). The rename
 * is an expand/contract migration in three release phases, so that a rollback
 * or a self-hosted server that upgrades late never loses anyone's language:
 *
 * Phase 1 (expand, this release): read `LOCALE_COOKIE` first and fall back to
 * this name; every writer writes both names with the same value and
 * attributes; nothing expires this cookie. A rollback to a release that knows
 * only this name still finds the choice.
 *
 * Phase 2 (stop writing), in a later release once phase 1 has been in
 * production past its rollback window: `localeCookies` writes only
 * `LOCALE_COOKIE`, and a page document that still carries this cookie expires
 * it (empty value, `Max-Age=0; Path=/mikka; SameSite=Lax`). Reading stays.
 *
 * Phase 3 (stop reading), once the oldest supported self-hosted release writes
 * `LOCALE_COOKIE` and at least one cookie lifetime (Max-Age one year) has
 * passed since phase 2 shipped: delete this constant and the fallback in
 * `storedLocale`, and drop the exception in scripts/next-free-locale.test.mjs.
 *
 * Only this module may use this constant; readers and writers call its helpers.
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

/** The names every writer writes in this phase (phase 1: both). */
export const WRITTEN_LOCALE_COOKIES = Object.freeze([LOCALE_COOKIE, LEGACY_LOCALE_COOKIE])

/**
 * The Set-Cookie values (or `document.cookie` assignments, one each) that
 * store a choice under every name written in this phase, with one set of
 * attributes.
 * @param {string} locale
 * @param {string} [path]
 * @returns {string[]}
 */
export function localeCookies(locale, path = basePath) {
  return WRITTEN_LOCALE_COOKIES.map(name => `${name}=${locale}; Max-Age=${LOCALE_COOKIE_MAX_AGE}; Path=${path || '/'}; SameSite=Lax`)
}

/**
 * True when the browser already holds `locale` under every written name, so a
 * response needs no Set-Cookie.
 * @param {(name: string) => string | undefined} read
 * @param {string} locale
 */
export function localeCookiesCurrent(read, locale) {
  return WRITTEN_LOCALE_COOKIES.every(name => read(name) === locale)
}
