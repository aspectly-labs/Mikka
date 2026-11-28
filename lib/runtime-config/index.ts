/**
 * T4 — Typed Remote Runtime Config runtime.
 *
 * Reads are synchronous, never throw, and never block on network I/O.
 * Precedence order:
 * 1. Test-only overrides set via `overrideRuntimeConfig` (rejected in
 *    deployments and production builds);
 * 2. Cached remote payload validated against its strict Zod schema,
 *    environment scope, and active `[startAt, endAt)` time window;
 * 3. The definition's schema-validated fallback.
 *
 * Remote refreshes are triggered lazily on reads using the default runtime
 * environment and throttled by `RUNTIME_CONFIG_REFRESH_MS` (no background
 * polling timers).
 */
import type { z } from 'zod'
import { deploymentStage } from '../deployment-stage.mjs'
import { getPublicPosthogHost, getPublicPosthogKey, runtimeEnv, type EnvMap } from '@/lib/env'
import {
  createPostHogRuntimeConfigAdapter,
  parseRuntimeConfigJson,
  type RuntimeConfigAdapter,
} from './adapters'
import {
  RUNTIME_CONFIG_DEFINITIONS,
  type RuntimeConfigDefinition,
  type RuntimeConfigEnvironment,
  type RuntimeConfigInput,
  type RuntimeConfigKey,
  type RuntimeConfigValue,
} from './schema'

export * from './schema'
export * from './adapters'

export const RUNTIME_CONFIG_REFRESH_MS = 60_000

const OVERRIDES = Symbol.for('mikka.runtimeConfigOverrides')

type OverridesMap = Map<RuntimeConfigKey, unknown>

interface RuntimeConfigState {
  payloads: Record<string, unknown>
  at: number | null
  loaded: boolean
  pending: Promise<boolean> | null
  adapter: RuntimeConfigAdapter | null
  epoch: number
}

const state: RuntimeConfigState = {
  payloads: {},
  at: null,
  loaded: false,
  pending: null,
  adapter: null,
  epoch: 0,
}

/**
 * Maps the deployment stage into the three runtime-config target environments
 * (`production`, `preview`, or `local`).
 */
export function runtimeConfigEnvironment(env: EnvMap = runtimeEnv()): RuntimeConfigEnvironment {
  const stage = deploymentStage(env)
  if (stage === 'production' || stage === 'preview') return stage
  return 'local'
}

function resolveRuntimeEnvironmentName(env: EnvMap): RuntimeConfigEnvironment | null {
  try {
    return runtimeConfigEnvironment(env)
  } catch {
    return null
  }
}

function isProductionOrDeploymentEnv(env: EnvMap): boolean {
  if (env.NODE_ENV === 'production') return true
  try {
    return Boolean(deploymentStage(env))
  } catch {
    // Malformed MIKKA_DEPLOYMENT_STAGE fails closed as deployed.
    return true
  }
}

export interface EvaluateRuntimeConfigOptions {
  now?: number
  environment?: RuntimeConfigEnvironment | null
  env?: EnvMap
}

/**
 * Pure payload evaluator for any `RuntimeConfigDefinition`.
 * Enforces environment scoping, strict Zod validation, and `[startAt, endAt)`
 * time-window bounds, falling back to `definition.fallback` on any violation.
 */
export function evaluateRuntimeConfigDefinition<TSchema extends z.ZodTypeAny>(
  definition: RuntimeConfigDefinition<TSchema>,
  raw: unknown,
  options: EvaluateRuntimeConfigOptions = {},
): z.infer<TSchema> {
  if (definition.environments) {
    const environment = options.environment !== undefined
      ? options.environment
      : resolveRuntimeEnvironmentName(options.env ?? runtimeEnv())
    if (environment === null || !definition.environments.includes(environment)) {
      return definition.fallback
    }
  }

  if (raw === undefined) return definition.fallback

  const decoded = parseRuntimeConfigJson(raw)
  if (!decoded.ok) return definition.fallback

  const parsed = definition.schema.safeParse(decoded.value)
  if (!parsed.success) return definition.fallback

  const value = parsed.data
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const timed = value as { startAt?: unknown; endAt?: unknown }
    if (timed.startAt !== undefined || timed.endAt !== undefined) {
      const now = options.now ?? Date.now()
      if (!Number.isFinite(now)) return definition.fallback

      const startMs = typeof timed.startAt === 'string' ? Date.parse(timed.startAt) : undefined
      const endMs = typeof timed.endAt === 'string' ? Date.parse(timed.endAt) : undefined

      if (startMs !== undefined && Number.isNaN(startMs)) return definition.fallback
      if (endMs !== undefined && Number.isNaN(endMs)) return definition.fallback
      if (startMs !== undefined && endMs !== undefined && startMs >= endMs) return definition.fallback
      if (startMs !== undefined && now < startMs) return definition.fallback
      if (endMs !== undefined && now >= endMs) return definition.fallback
    }
  }

  return value
}

/** Evaluates a raw payload for a registered runtime-config key. */
export function evaluateRuntimeConfigPayload<K extends RuntimeConfigKey>(
  key: K,
  raw: unknown,
  options: EvaluateRuntimeConfigOptions = {},
): RuntimeConfigValue<K> {
  const definition: RuntimeConfigDefinition<z.ZodTypeAny> = RUNTIME_CONFIG_DEFINITIONS[key]
  return evaluateRuntimeConfigDefinition(definition, raw, options) as RuntimeConfigValue<K>
}

function testOverrides(): OverridesMap | undefined {
  return (globalThis as { [OVERRIDES]?: OverridesMap })[OVERRIDES]
}

function assertTestOnlyOverrides(env: EnvMap = runtimeEnv()): void {
  const liveEnv = runtimeEnv()
  if (isProductionOrDeploymentEnv(liveEnv) || (env !== liveEnv && isProductionOrDeploymentEnv(env))) {
    throw new Error('overrideRuntimeConfig is for tests only')
  }
}

/**
 * Tests only: sets a typed runtime-config override (`undefined` clears it)
 * ahead of remote payloads. Throws in deployments and production builds;
 * only test files may import it (`runtime-config.test.ts` checks both).
 */
export function overrideRuntimeConfig<K extends RuntimeConfigKey>(
  key: K,
  value: RuntimeConfigInput<K> | undefined,
  env: EnvMap = runtimeEnv(),
): void {
  assertTestOnlyOverrides(env)
  const holder = globalThis as { [OVERRIDES]?: OverridesMap }
  const map = holder[OVERRIDES] ??= new Map<RuntimeConfigKey, unknown>()
  if (value === undefined) {
    map.delete(key)
    return
  }
  const parsed = RUNTIME_CONFIG_DEFINITIONS[key].schema.parse(value)
  map.set(key, parsed)
}

/** Tests only: clears all runtime-config overrides. */
export function clearRuntimeConfigOverrides(env: EnvMap = runtimeEnv()): void {
  assertTestOnlyOverrides(env)
  testOverrides()?.clear()
}

export interface RefreshRuntimeConfigOptions {
  adapter?: RuntimeConfigAdapter | null
  env?: EnvMap
  token?: string
  apiHost?: string
  fetcher?: typeof fetch
  timeoutMs?: number
  now?: number
}

function resolveAdapter(options: RefreshRuntimeConfigOptions, env: EnvMap): RuntimeConfigAdapter | null {
  if (options.adapter !== undefined) return options.adapter
  if (options.token !== undefined || options.apiHost !== undefined || options.fetcher !== undefined) {
    const token = (options.token ?? getPublicPosthogKey(env)).trim()
    if (!token) return null
    return createPostHogRuntimeConfigAdapter({
      token,
      apiHost: options.apiHost ?? getPublicPosthogHost(env),
      fetcher: options.fetcher,
      timeoutMs: options.timeoutMs,
    })
  }
  if (state.adapter !== null) return state.adapter
  const token = getPublicPosthogKey(env).trim()
  if (!token || typeof fetch !== 'function') return null
  return createPostHogRuntimeConfigAdapter({
    token,
    apiHost: getPublicPosthogHost(env),
    timeoutMs: options.timeoutMs,
  })
}

function isWarm(now: number): boolean {
  return state.at !== null && Math.abs(now - state.at) < RUNTIME_CONFIG_REFRESH_MS
}

function startSingleFlightRefresh(options: RefreshRuntimeConfigOptions, now: number): Promise<boolean> | null {
  const env = options.env ?? runtimeEnv()
  if (resolveRuntimeEnvironmentName(env) === null) return null
  const adapter = resolveAdapter(options, env)
  if (!adapter) return null
  const refreshEpoch = state.epoch
  state.at = state.at === null ? now : Math.max(state.at, now)
  const work = refreshRuntimeConfig({ ...options, adapter, env, now })
    .catch(() => false)
    .finally(() => {
      if (state.epoch === refreshEpoch && state.pending === work) state.pending = null
    })
  state.pending = work
  return work
}

function scheduleRefresh(now: number, env: EnvMap): void {
  if (!Number.isFinite(now)) return
  if (state.pending || isWarm(now)) return
  startSingleFlightRefresh({ env }, now)
}

export interface GetRuntimeConfigOptions {
  env?: EnvMap
  now?: number
}

/**
 * Reads the current typed value for `key`. Synchronous, never throws, never
 * waits. Triggers a throttled background refresh when reading with the default
 * runtime environment.
 */
export function getRuntimeConfig<K extends RuntimeConfigKey>(
  key: K,
  options: GetRuntimeConfigOptions = {},
): RuntimeConfigValue<K> {
  const definition = RUNTIME_CONFIG_DEFINITIONS[key]
  const defaultEnv = runtimeEnv()
  const env = options.env ?? defaultEnv
  const now = options.now ?? Date.now()
  if (options.env === undefined || options.env === defaultEnv) {
    scheduleRefresh(now, defaultEnv)
  }

  const environment = resolveRuntimeEnvironmentName(env)
  const allowOverrides = !isProductionOrDeploymentEnv(defaultEnv)
    && (env === defaultEnv || !isProductionOrDeploymentEnv(env))
  if (allowOverrides) {
    const overrides = testOverrides()
    if (overrides?.has(key)) {
      return evaluateRuntimeConfigPayload(key, overrides.get(key), { now, environment })
    }
  }

  const raw = Object.hasOwn(state.payloads, definition.flag) ? state.payloads[definition.flag] : undefined
  return evaluateRuntimeConfigPayload(key, raw, { now, environment })
}

/**
 * Ensures remote runtime config has completed an initial load (or fresh refresh
 * within `RUNTIME_CONFIG_REFRESH_MS`) for async server entrypoints such as
 * billing catalog and Checkout on a cold container. Joins any in-flight refresh
 * (single-flight), returns immediately when warm or unconfigured, and throttles
 * outage retries for `RUNTIME_CONFIG_REFRESH_MS`.
 */
export async function ensureRuntimeConfigLoaded(
  options: RefreshRuntimeConfigOptions = {},
): Promise<boolean> {
  if (state.pending) return state.pending
  const now = options.now ?? Date.now()
  if (!Number.isFinite(now)) return false
  if (isWarm(now)) return state.loaded
  const work = startSingleFlightRefresh(options, now)
  if (!work) return state.loaded
  return work
}

/**
 * Fetches fresh payloads from the active adapter and updates the in-memory
 * cache. When the adapter returns `null` or fails, previously cached values
 * are preserved intact.
 */
export async function refreshRuntimeConfig(options: RefreshRuntimeConfigOptions = {}): Promise<boolean> {
  const env = options.env ?? runtimeEnv()
  const adapter = resolveAdapter(options, env)
  if (!adapter) return false

  const refreshEpoch = state.epoch
  const flags = Object.values(RUNTIME_CONFIG_DEFINITIONS).map(definition => definition.flag)
  const environment = resolveRuntimeEnvironmentName(env)
  if (environment === null) return false

  let payloads: Record<string, unknown> | null
  try {
    payloads = await adapter.fetchPayloads({
      flags,
      environment,
      timeoutMs: options.timeoutMs,
    })
  } catch {
    return false
  }

  if (!payloads || state.epoch !== refreshEpoch) return false
  const fetchedAt = options.now ?? Date.now()
  state.payloads = { ...payloads }
  state.at = state.at === null ? fetchedAt : Math.max(state.at, fetchedAt)
  state.loaded = true
  return true
}

/** Installs or clears a custom runtime-config adapter (e.g. KV/DB or composite). */
export function setRuntimeConfigAdapter(adapter: RuntimeConfigAdapter | null): void {
  state.adapter = adapter
}

/** Resets cached remote payloads, refresh throttling, and custom adapter state. */
export function resetRuntimeConfig(): void {
  state.epoch += 1
  state.payloads = {}
  state.at = null
  state.loaded = false
  state.pending = null
  state.adapter = null
}
