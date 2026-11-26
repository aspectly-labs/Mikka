/**
 * T4 — Pluggable Remote Runtime Config adapters.
 *
 * Provides resilient payload loaders for PostHog `/flags?v=2`, key-value
 * stores (DB or Cloudflare KV), and precedence-ordered composite chains.
 * Returning `null` signals an outage or unavailable source so callers keep
 * their previously cached values.
 */
import { DEFAULT_POSTHOG_API_HOST } from '@/lib/env'
import type { RuntimeConfigEnvironment } from './schema'

export const RUNTIME_CONFIG_DISTINCT_ID = 'mikka-deployment'
export const DEFAULT_RUNTIME_CONFIG_TIMEOUT_MS = 2_000

export interface RuntimeConfigAdapter {
  readonly name: string
  fetchPayloads(input: {
    flags: readonly string[]
    environment: RuntimeConfigEnvironment
    timeoutMs?: number
  }): Promise<Record<string, unknown> | null>
}

export interface PostHogRuntimeConfigAdapterOptions {
  token: string
  apiHost?: string
  distinctId?: string
  fetcher?: typeof fetch
  timeoutMs?: number
}

export interface KeyValueRuntimeConfigAdapterOptions {
  name?: string
  read: (keys: readonly string[]) => Promise<Record<string, unknown> | null>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Decodes a raw payload value, parsing JSON strings safely without throwing. */
export function parseRuntimeConfigJson(raw: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof raw !== 'string') return { ok: true, value: raw }
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(trimmed) }
  } catch {
    return { ok: false }
  }
}

/**
 * PostHog `/flags?v=2` runtime config adapter.
 *
 * Extracts payloads from `result.flags[flag].metadata?.payload` with fallback
 * to `result.flagPayloads?.[flag]`, parsing stringified JSON payloads safely.
 * Returns `null` on HTTP errors, `errorsWhileComputingFlags !== false`,
 * `quotaLimited` containing `'feature_flags'`, malformed envelopes, or network
 * failures so outages preserve previously cached values.
 */
export function createPostHogRuntimeConfigAdapter(
  options: PostHogRuntimeConfigAdapterOptions,
): RuntimeConfigAdapter {
  const token = options.token.trim()
  const apiHost = (options.apiHost?.trim() || DEFAULT_POSTHOG_API_HOST).replace(/\/+$/, '')
  const distinctId = options.distinctId?.trim() || RUNTIME_CONFIG_DISTINCT_ID
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_RUNTIME_CONFIG_TIMEOUT_MS

  return {
    name: 'posthog',
    async fetchPayloads({ flags, environment, timeoutMs }) {
      if (!token) return null
      if (flags.length === 0) return {}
      const fetcher = options.fetcher ?? (typeof fetch === 'function' ? fetch : undefined)
      if (!fetcher) return null

      const effectiveTimeoutMs = timeoutMs ?? defaultTimeoutMs
      let response: Response
      try {
        response = await fetcher(`${apiHost}/flags?v=2`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'posthog-node/mikka-runtime-config',
          },
          body: JSON.stringify({
            api_key: token,
            distinct_id: distinctId,
            flag_keys_to_evaluate: flags,
            person_properties: { deployment: environment },
          }),
          // Never follow a redirect with the project token.
          cache: 'no-store',
          redirect: 'manual',
          signal: AbortSignal.timeout(effectiveTimeoutMs),
        })
      } catch {
        return null
      }

      if (!response.ok) return null

      let result: unknown
      try {
        result = await response.json()
      } catch {
        return null
      }

      if (!isRecord(result)) return null
      if (result.errorsWhileComputingFlags !== false) return null
      if (Array.isArray(result.quotaLimited) && result.quotaLimited.includes('feature_flags')) return null

      if (result.flags !== undefined && !isRecord(result.flags)) return null
      if (result.flagPayloads !== undefined && !isRecord(result.flagPayloads)) return null

      const flagsRecord = isRecord(result.flags) ? result.flags : null
      const flagPayloadsRecord = isRecord(result.flagPayloads) ? result.flagPayloads : null
      if (!flagsRecord && !flagPayloadsRecord) return null

      const payloads: Record<string, unknown> = {}
      for (const flag of flags) {
        const flagEntry = flagsRecord && isRecord(flagsRecord[flag]) ? flagsRecord[flag] : undefined
        if (flagEntry?.enabled === false) continue

        const metadata = flagEntry && isRecord(flagEntry.metadata) ? flagEntry.metadata : undefined
        const rawPayload = metadata && Object.hasOwn(metadata, 'payload') && metadata.payload !== undefined
          ? metadata.payload
          : flagPayloadsRecord && Object.hasOwn(flagPayloadsRecord, flag) && flagPayloadsRecord[flag] !== undefined
            ? flagPayloadsRecord[flag]
            : undefined

        if (rawPayload === undefined) continue
        const decoded = parseRuntimeConfigJson(rawPayload)
        if (decoded.ok) payloads[flag] = decoded.value
      }

      return payloads
    },
  }
}

/**
 * Pluggable key-value adapter backed by a database table, Cloudflare KV, or
 * custom async reader. JSON string values are parsed safely.
 */
export function createKeyValueRuntimeConfigAdapter(
  options: KeyValueRuntimeConfigAdapterOptions,
): RuntimeConfigAdapter {
  const name = options.name?.trim() || 'key-value'
  return {
    name,
    async fetchPayloads({ flags }) {
      if (flags.length === 0) return {}
      let raw: Record<string, unknown> | null
      try {
        raw = await options.read(flags)
      } catch {
        return null
      }
      if (!raw || !isRecord(raw)) return null

      const payloads: Record<string, unknown> = {}
      for (const flag of flags) {
        if (!Object.hasOwn(raw, flag) || raw[flag] === undefined) continue
        const decoded = parseRuntimeConfigJson(raw[flag])
        if (decoded.ok) payloads[flag] = decoded.value
      }
      return payloads
    },
  }
}

/**
 * Merges multiple adapters in precedence order: earlier adapters win per key,
 * falling through when an earlier adapter fails (`null`), omits a key, or
 * returns `null` for that key. Returns `null` when every adapter fails.
 */
export function createCompositeRuntimeConfigAdapter(
  adapters: readonly RuntimeConfigAdapter[],
): RuntimeConfigAdapter {
  const name = adapters.length > 0
    ? `composite(${adapters.map(adapter => adapter.name).join(',')})`
    : 'composite'

  return {
    name,
    async fetchPayloads(input) {
      if (adapters.length === 0) return null
      if (input.flags.length === 0) return {}

      const results = await Promise.all(
        adapters.map(async adapter => {
          try {
            return await adapter.fetchPayloads(input)
          } catch {
            return null
          }
        }),
      )

      let anySucceeded = false
      const merged: Record<string, unknown> = {}

      for (const result of results) {
        if (!result || !isRecord(result)) continue
        anySucceeded = true
        for (const flag of input.flags) {
          if (!Object.hasOwn(result, flag) || result[flag] === undefined) continue
          if (!Object.hasOwn(merged, flag)) {
            merged[flag] = result[flag]
          } else if (merged[flag] === null && result[flag] !== null) {
            merged[flag] = result[flag]
          }
        }
      }

      return anySucceeded ? merged : null
    },
  }
}
