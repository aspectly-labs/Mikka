/**
 * Zero-dependency runtime environment reader shared by ESM build scripts
 * (.mjs) and TypeScript modules. Only `lib/env/**` reads `process.env`
 * directly (G1: `no-raw-process-env`).
 */

/** @typedef {Readonly<Record<string, string | undefined>>} EnvMap */

/** @returns {EnvMap} */
export function runtimeEnv() {
  return typeof process === 'undefined' ? {} : process.env
}

/**
 * Returns the raw value of an environment variable, or undefined.
 * @param {string} name
 * @param {EnvMap} [env]
 * @returns {string | undefined}
 */
export function envValue(name, env = runtimeEnv()) {
  return env[name]
}

/**
 * Returns a trimmed non-empty value of an environment variable, or undefined.
 * @param {string} name
 * @param {EnvMap} [env]
 * @returns {string | undefined}
 */
export function envTrimmed(name, env = runtimeEnv()) {
  const raw = env[name]?.trim()
  return raw ? raw : undefined
}
