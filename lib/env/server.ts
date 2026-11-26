/**
 * T2 — Typed server environment boundary.
 *
 * Centralizes `process.env` reads behind Zod-validated typed helpers so
 * production modules never touch `process.env` directly (G1) and tests can
 * inject explicit `EnvMap` objects without mutating global state.
 */
import { z } from 'zod'
import { envTrimmed, envValue, runtimeEnv, type EnvMap } from './runtime.mjs'

export { envTrimmed, envValue, runtimeEnv, type EnvMap }

const optionalNonEmpty = z.preprocess(
  value => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
  z.string().min(1).optional(),
)

const optionalHttpUrl = z.preprocess(
  value => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
  z.url({ protocol: /^https?$/ }).optional(),
)

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).optional(),
  MIKKA_EDITION: z.preprocess(
    value => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
    z.enum(['cloud', 'community']).optional(),
  ),
  MIKKA_DEPLOYMENT_STAGE: z.preprocess(
    value => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
    z.enum(['production', 'preview', 'development']).optional(),
  ),
  MIKKA_DEPLOYMENT_ENVIRONMENT: z.preprocess(
    value => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
    z.enum(['production', 'preview', 'development']).optional(),
  ),
  MIKKA_DEPLOYMENT_ID: optionalNonEmpty,
  MIKKA_APP_ORIGIN: optionalHttpUrl,
  BETTER_AUTH_URL: optionalHttpUrl,
  MIKKA_EVE_ORIGIN: optionalHttpUrl,
  DATABASE_URL: optionalNonEmpty,
  MIKKA_DATABASE_URL: optionalNonEmpty,
  STRIPE_SECRET_KEY: optionalNonEmpty,
  STRIPE_TEAM_PRICE_ID: optionalNonEmpty,
  STRIPE_TEAM_RESOURCE_PRICE_ID: optionalNonEmpty,
  STRIPE_WEBHOOK_SECRET: optionalNonEmpty,
  LITELLM_BASE_URL: optionalHttpUrl,
  E2B_API_KEY: optionalNonEmpty,
  POSTHOG_HOST: optionalHttpUrl,
  MIKKA_PUBLIC_POSTHOG_KEY: optionalNonEmpty,
})

export type ServerEnv = z.infer<typeof serverEnvSchema>

/** Parses and validates the canonical server environment shape with Zod. */
export function parseServerEnv(env: EnvMap = runtimeEnv()): ServerEnv {
  return serverEnvSchema.parse({
    NODE_ENV: env.NODE_ENV,
    MIKKA_EDITION: env.MIKKA_EDITION,
    MIKKA_DEPLOYMENT_STAGE: env.MIKKA_DEPLOYMENT_STAGE,
    MIKKA_DEPLOYMENT_ENVIRONMENT: env.MIKKA_DEPLOYMENT_ENVIRONMENT,
    MIKKA_DEPLOYMENT_ID: env.MIKKA_DEPLOYMENT_ID,
    MIKKA_APP_ORIGIN: env.MIKKA_APP_ORIGIN,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
    MIKKA_EVE_ORIGIN: env.MIKKA_EVE_ORIGIN,
    DATABASE_URL: env.DATABASE_URL,
    MIKKA_DATABASE_URL: env.MIKKA_DATABASE_URL,
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
    STRIPE_TEAM_PRICE_ID: env.STRIPE_TEAM_PRICE_ID,
    STRIPE_TEAM_RESOURCE_PRICE_ID: env.STRIPE_TEAM_RESOURCE_PRICE_ID,
    STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET,
    LITELLM_BASE_URL: env.LITELLM_BASE_URL,
    E2B_API_KEY: env.E2B_API_KEY,
    POSTHOG_HOST: env.POSTHOG_HOST,
    MIKKA_PUBLIC_POSTHOG_KEY: env.MIKKA_PUBLIC_POSTHOG_KEY,
  })
}

/** Raw value lookup (preserves exact string or undefined for callers that distinguish empty vs unset). */
export function readEnv(name: string, env: EnvMap = runtimeEnv()): string | undefined {
  return envValue(name, env)
}

/** Trimmed non-empty string lookup, or undefined when unset/blank. */
export function envString(name: string, env: EnvMap = runtimeEnv()): string | undefined {
  return envTrimmed(name, env)
}

/** Required non-empty env value; throws naming only the variable (never a value). */
export function envRequired(name: string, env: EnvMap = runtimeEnv()): string {
  const value = envTrimmed(name, env)
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

/** Exact-value check (e.g. `envExact('FOO', '1')`). */
export function envExact(name: string, expected = '1', env: EnvMap = runtimeEnv()): boolean {
  return env[name] === expected
}

/** Parses common boolean env strings (`1`/`true`/`yes`/`on` vs `0`/`false`/`no`/`off`), else fallback. */
export function envBool(name: string, fallback = false, env: EnvMap = runtimeEnv()): boolean {
  const raw = env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false
  return fallback
}

/** Parses a bounded integer env var with fallback when unset or unparseable. */
export function envInt(
  name: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
  env: EnvMap = runtimeEnv(),
): number {
  const raw = envTrimmed(name, env)
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) return fallback
  if (options.min !== undefined && parsed < options.min) return fallback
  if (options.max !== undefined && parsed > options.max) return fallback
  return parsed
}

/** Parses a bounded finite number env var with fallback when unset or invalid. */
export function envNumber(
  name: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
  env: EnvMap = runtimeEnv(),
): number {
  const raw = envTrimmed(name, env)
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  if (options.min !== undefined && parsed < options.min) return fallback
  if (options.max !== undefined && parsed > options.max) return fallback
  return parsed
}

/** Parses a validated http(s) URL env var, returning undefined if unset and throwing if malformed. */
export function envUrl(name: string, env: EnvMap = runtimeEnv()): string | undefined {
  const raw = envTrimmed(name, env)
  if (!raw) return undefined
  try {
    return optionalHttpUrl.parse(raw)
  } catch (error) {
    throw new Error(`Invalid URL in environment variable: ${name}`, { cause: error })
  }
}

/** Parses a comma-separated list of trimmed non-empty strings. */
export function envList(name: string, env: EnvMap = runtimeEnv()): string[] {
  const raw = envTrimmed(name, env)
  if (!raw) return []
  return raw.split(',').map(item => item.trim()).filter(Boolean)
}

/** Returns a shallow mutable copy of the active environment (safe for child process spawning). */
export function envSnapshot(overrides?: Record<string, string | undefined>, env: EnvMap = runtimeEnv()): Record<string, string | undefined> {
  return overrides ? { ...env, ...overrides } : { ...env }
}
