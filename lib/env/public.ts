/**
 * T2 — Typed public/client environment boundary.
 *
 * Absorbs `lib/public-env.mjs` with Zod validation while keeping the phase-1
 * `NEXT_PUBLIC_*` legacy table exclusively in `lib/public-env.mjs`
 * (enforced by `scripts/next-free-env.test.mjs`).
 *
 * Browser bundles inline literal `process.env.<NAME>` references configured in
 * `apps/frontend/vite.config.mjs` and `apps/api/nitro.config.ts`. Keeping those
 * literal reads inside `lib/env/public.ts` satisfies both bundler inlining and
 * G1 (`no-raw-process-env`) across the rest of the codebase.
 */
import { z } from 'zod'
import {
  LEGACY_PUBLIC_ENV,
  legacyPublicName,
  publicEnv,
  withLegacyPublicDefines,
  withLegacyPublicNames,
  type Environment,
  type PublicEnvName,
} from '../public-env.mjs'
import { runtimeEnv } from './runtime.mjs'

export {
  LEGACY_PUBLIC_ENV,
  legacyPublicName,
  publicEnv,
  withLegacyPublicDefines,
  withLegacyPublicNames,
  type Environment,
  type PublicEnvName,
}

const optionalTrimmed = z.preprocess(
  value => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
  z.string().min(1).optional(),
)

const optionalHttpUrl = z.preprocess(
  value => (typeof value === 'string' && value.trim() ? value.trim().replace(/\/+$/, '') : undefined),
  z.url({ protocol: /^https?$/ }).optional(),
)

export const publicEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  MIKKA_BASE_PATH: z.string().default(''),
  MIKKA_PUBLIC_BUILD: z.string().default(''),
  MIKKA_DEPLOYMENT_ID: z.string().default(''),
  MIKKA_PUBLIC_POSTHOG_KEY: optionalTrimmed,
  POSTHOG_HOST: optionalHttpUrl,
  MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY: optionalTrimmed,
  MIKKA_PUBLIC_TURNSTILE_SITE_KEY: optionalTrimmed,
  MIKKA_PUBLIC_COMPUTER_ENABLED: optionalTrimmed,
  MIKKA_PUBLIC_COMPUTER_MOCK: optionalTrimmed,
  MIKKA_PUBLIC_COMPUTER_DEPLOYMENT: optionalTrimmed,
  MIKKA_PUBLIC_COMPUTER_ACCEPTANCE: optionalTrimmed,
  MIKKA_DAEMON_PACKAGE_NAME: z.preprocess(
    value => (typeof value === 'string' && value.trim() ? value.trim() : '@aspectlylabs/mikka'),
    z.string().min(1),
  ),
})

export type PublicEnv = z.infer<typeof publicEnvSchema>

export const DEFAULT_POSTHOG_API_HOST = 'https://us.i.posthog.com'
export const DEFAULT_POSTHOG_UI_HOST = 'https://us.posthog.com'

function inlinedOrRuntime(inlined: string | undefined, name: PublicEnvName, env?: Environment): string | undefined {
  if (env !== undefined) return publicEnv(name, env)
  return inlined || publicEnv(name, runtimeEnv())
}

/** Bundler-safe public env snapshot validated with Zod. */
export function readPublicEnv(env?: Environment): PublicEnv {
  const source = env ?? runtimeEnv()
  const rawNodeEnv = env !== undefined ? source.NODE_ENV : (process.env.NODE_ENV ?? source.NODE_ENV)
  const nodeEnv = rawNodeEnv === 'production' || rawNodeEnv === 'test' || rawNodeEnv === 'development'
    ? rawNodeEnv
    : 'development'
  return publicEnvSchema.parse({
    NODE_ENV: nodeEnv,
    MIKKA_BASE_PATH: env !== undefined ? (source.MIKKA_BASE_PATH ?? '') : (process.env.MIKKA_BASE_PATH ?? source.MIKKA_BASE_PATH ?? ''),
    MIKKA_PUBLIC_BUILD: inlinedOrRuntime(process.env.MIKKA_PUBLIC_BUILD, 'MIKKA_PUBLIC_BUILD', env) ?? '',
    MIKKA_DEPLOYMENT_ID: env !== undefined ? (source.MIKKA_DEPLOYMENT_ID ?? '') : (process.env.MIKKA_DEPLOYMENT_ID ?? source.MIKKA_DEPLOYMENT_ID ?? ''),
    MIKKA_PUBLIC_POSTHOG_KEY: inlinedOrRuntime(process.env.MIKKA_PUBLIC_POSTHOG_KEY, 'MIKKA_PUBLIC_POSTHOG_KEY', env),
    POSTHOG_HOST: inlinedOrRuntime(process.env.POSTHOG_HOST, 'POSTHOG_HOST', env),
    MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY: inlinedOrRuntime(process.env.MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY, 'MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY', env),
    MIKKA_PUBLIC_TURNSTILE_SITE_KEY: inlinedOrRuntime(process.env.MIKKA_PUBLIC_TURNSTILE_SITE_KEY, 'MIKKA_PUBLIC_TURNSTILE_SITE_KEY', env),
    MIKKA_PUBLIC_COMPUTER_ENABLED: inlinedOrRuntime(process.env.MIKKA_PUBLIC_COMPUTER_ENABLED, 'MIKKA_PUBLIC_COMPUTER_ENABLED', env),
    MIKKA_PUBLIC_COMPUTER_MOCK: inlinedOrRuntime(process.env.MIKKA_PUBLIC_COMPUTER_MOCK, 'MIKKA_PUBLIC_COMPUTER_MOCK', env),
    MIKKA_PUBLIC_COMPUTER_DEPLOYMENT: inlinedOrRuntime(process.env.MIKKA_PUBLIC_COMPUTER_DEPLOYMENT, 'MIKKA_PUBLIC_COMPUTER_DEPLOYMENT', env),
    MIKKA_PUBLIC_COMPUTER_ACCEPTANCE: inlinedOrRuntime(process.env.MIKKA_PUBLIC_COMPUTER_ACCEPTANCE, 'MIKKA_PUBLIC_COMPUTER_ACCEPTANCE', env),
    MIKKA_DAEMON_PACKAGE_NAME: inlinedOrRuntime(process.env.MIKKA_DAEMON_PACKAGE_NAME, 'MIKKA_DAEMON_PACKAGE_NAME', env),
  })
}

export function getPublicBasePath(env?: Environment): string {
  if (env !== undefined) return env.MIKKA_BASE_PATH ?? ''
  return process.env.MIKKA_BASE_PATH ?? ''
}

export function getPublicBuild(env?: Environment): string {
  return inlinedOrRuntime(process.env.MIKKA_PUBLIC_BUILD, 'MIKKA_PUBLIC_BUILD', env) ?? ''
}

export function getPublicDeploymentId(env?: Environment): string {
  if (env !== undefined) return env.MIKKA_DEPLOYMENT_ID ?? ''
  return process.env.MIKKA_DEPLOYMENT_ID ?? ''
}

export function getPublicUiOverlaySha(env?: Environment): string {
  if (env !== undefined) return env.MIKKA_UI_OVERLAY_SHA ?? ''
  return process.env.MIKKA_UI_OVERLAY_SHA ?? ''
}

export function getTestBuildSha(env?: Environment): string {
  if (env !== undefined) return env.MIKKA_TEST_BUILD_SHA ?? ''
  return process.env.MIKKA_TEST_BUILD_SHA ?? ''
}

export function getPublicPosthogKey(env?: Environment): string {
  return inlinedOrRuntime(process.env.MIKKA_PUBLIC_POSTHOG_KEY, 'MIKKA_PUBLIC_POSTHOG_KEY', env) ?? ''
}

export function getPublicPosthogHost(env?: Environment): string {
  const raw = inlinedOrRuntime(process.env.POSTHOG_HOST, 'POSTHOG_HOST', env)
  const parsed = optionalHttpUrl.safeParse(raw)
  return parsed.success && parsed.data ? parsed.data : DEFAULT_POSTHOG_API_HOST
}

export function getPublicStripePublishableKey(env?: Environment): string | undefined {
  return inlinedOrRuntime(process.env.MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY, 'MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY', env)
}

export function getPublicTurnstileSiteKey(env?: Environment): string | undefined {
  return inlinedOrRuntime(process.env.MIKKA_PUBLIC_TURNSTILE_SITE_KEY, 'MIKKA_PUBLIC_TURNSTILE_SITE_KEY', env)
}

export function getPublicComputerDeployment(env?: Environment): string | undefined {
  return inlinedOrRuntime(process.env.MIKKA_PUBLIC_COMPUTER_DEPLOYMENT, 'MIKKA_PUBLIC_COMPUTER_DEPLOYMENT', env)
}

export function getPublicComputerAcceptance(env?: Environment): string | undefined {
  return inlinedOrRuntime(process.env.MIKKA_PUBLIC_COMPUTER_ACCEPTANCE, 'MIKKA_PUBLIC_COMPUTER_ACCEPTANCE', env)
}

export function getPublicComputerEnabled(env?: Environment): string | undefined {
  return inlinedOrRuntime(process.env.MIKKA_PUBLIC_COMPUTER_ENABLED, 'MIKKA_PUBLIC_COMPUTER_ENABLED', env)
}

export function getPublicComputerMock(env?: Environment): string | undefined {
  return inlinedOrRuntime(process.env.MIKKA_PUBLIC_COMPUTER_MOCK, 'MIKKA_PUBLIC_COMPUTER_MOCK', env)
}

export function getPublicDaemonPackageName(env?: Environment): string {
  return inlinedOrRuntime(process.env.MIKKA_DAEMON_PACKAGE_NAME, 'MIKKA_DAEMON_PACKAGE_NAME', env) ?? '@aspectlylabs/mikka'
}

export function getNodeEnv(env?: Environment): string | undefined {
  if (env !== undefined) return env.NODE_ENV
  return process.env.NODE_ENV
}

export function isProductionEnv(env?: Environment): boolean {
  return getNodeEnv(env) === 'production'
}

export function isDevelopmentEnv(env?: Environment): boolean {
  return getNodeEnv(env) === 'development'
}

export function isTestEnv(env?: Environment): boolean {
  return getNodeEnv(env) === 'test'
}
