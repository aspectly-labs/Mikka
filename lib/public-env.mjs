/**
 * Public configuration names, read on the server, in build scripts and by the
 * bundler configurations that inline them for the browser.
 *
 * The retired framework's NEXT_PUBLIC_* prefix is being renamed in two phases
 * (docs/operations/public-env-rename.md). Phase 1: every reader takes the new
 * name first and falls back to the legacy one, so a deployment keeps working
 * while its configuration still carries the old names.
 *
 * One rule everywhere: an empty value counts as unset. An empty new name
 * falls back to the legacy name, and an empty legacy name to the default, the
 * same as the Cloudflare API ingress, which drops empty bindings
 * (cloudflare/api/ingress/environment.mjs). To turn a setting off during
 * phase 1, unset both names.
 *
 * Browser code cannot look a name up at run time: Vite and Nitro replace the
 * literal `process.env.<NEW_NAME>` (apps/frontend/vite.config.mjs,
 * apps/api/nitro.config.ts), and they take that value from publicEnv().
 */

// legacy NEXT_PUBLIC_* names, read only until production config is renamed; remove in phase 2
export const LEGACY_PUBLIC_ENV = Object.freeze({
  MIKKA_PUBLIC_BUILD: 'NEXT_PUBLIC_MIKKA_BUILD',
  MIKKA_PUBLIC_POSTHOG_KEY: 'NEXT_PUBLIC_POSTHOG_KEY',
  POSTHOG_HOST: 'NEXT_PUBLIC_POSTHOG_HOST',
  MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  MIKKA_PUBLIC_TURNSTILE_SITE_KEY: 'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
  MIKKA_PUBLIC_COMPUTER_ENABLED: 'NEXT_PUBLIC_COMPUTER_ENABLED',
  MIKKA_PUBLIC_COMPUTER_MOCK: 'NEXT_PUBLIC_COMPUTER_MOCK',
  MIKKA_PUBLIC_COMPUTER_DEPLOYMENT: 'NEXT_PUBLIC_COMPUTER_DEPLOYMENT',
  MIKKA_PUBLIC_COMPUTER_ACCEPTANCE: 'NEXT_PUBLIC_COMPUTER_ACCEPTANCE',
  MIKKA_DAEMON_PACKAGE_NAME: 'NEXT_PUBLIC_MIKKA_DAEMON_PACKAGE_NAME',
})

/** @typedef {keyof typeof LEGACY_PUBLIC_ENV} PublicEnvName */
/** @typedef {Readonly<Record<string, string | undefined>>} Environment */

/** @returns {Environment} */
function runtimeEnvironment() {
  return typeof process === 'undefined' ? {} : process.env
}

/**
 * The legacy name a public setting was read under, or undefined.
 * @param {string} name
 * @returns {string | undefined}
 */
export function legacyPublicName(name) {
  return Object.hasOwn(LEGACY_PUBLIC_ENV, name) ? LEGACY_PUBLIC_ENV[/** @type {PublicEnvName} */ (name)] : undefined
}

/**
 * A public setting: the new name when it is non-empty, otherwise its legacy
 * NEXT_PUBLIC_* name when that is non-empty, otherwise `fallback`.
 * @template {string | undefined} [F=undefined]
 * @param {PublicEnvName} name
 * @param {Environment} [env]
 * @param {F} [fallback]
 * @returns {string | F}
 */
export function publicEnv(name, env = runtimeEnvironment(), fallback) {
  const current = env[name]
  if (current) return current
  const legacy = legacyPublicName(name)
  const previous = legacy === undefined ? undefined : env[legacy]
  return previous ? previous : /** @type {F} */ (fallback)
}

/**
 * The same names with each one's legacy name added after it, for allowlists
 * that forward configuration to a child process or container.
 * @param {readonly string[]} names
 * @returns {string[]}
 */
export function withLegacyPublicNames(names) {
  return names.flatMap(name => {
    const legacy = legacyPublicName(name)
    return legacy === undefined ? [name] : [name, legacy]
  })
}

/**
 * Bundler replacements for `process.env.<NEW_NAME>`, plus the same value under
 * each legacy name, so code that still reads the legacy literal (such as a UI
 * layer built from another repository) gets the identical value.
 * @param {Record<string, string>} define
 * @returns {Record<string, string>}
 */
export function withLegacyPublicDefines(define) {
  const result = { ...define }
  for (const [key, value] of Object.entries(define)) {
    const legacy = key.startsWith('process.env.') ? legacyPublicName(key.slice('process.env.'.length)) : undefined
    if (legacy !== undefined) result['process.env.' + legacy] = value
  }
  return result
}
