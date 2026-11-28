import { LOCALE_COOKIE_MAX_AGE } from './locale-cookie.mjs'

export type AppLocale = 'zh-CN' | 'en'

/**
 * The application's locales and the cookie that remembers an explicit choice.
 *
 * This used to be built by the framework's `defineRouting`, which only returns
 * its argument; keeping the plain object removes the last framework import from
 * the locale configuration while leaving the values unchanged.
 */
export const routing: {
  locales: readonly AppLocale[]
  defaultLocale: AppLocale
  localePrefix: 'as-needed'
  localeCookie: { maxAge: number }
} = {
  locales: ['zh-CN', 'en'],
  defaultLocale: 'zh-CN',
  localePrefix: 'as-needed',
  // The cookie's name and attributes are in ./locale-cookie.mjs.
  localeCookie: { maxAge: LOCALE_COOKIE_MAX_AGE },
}
