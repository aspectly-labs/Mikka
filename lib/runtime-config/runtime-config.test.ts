import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { beforeEach, test } from 'node:test'
import {
  clearRuntimeConfigOverrides,
  createCompositeRuntimeConfigAdapter,
  createKeyValueRuntimeConfigAdapter,
  createPostHogRuntimeConfigAdapter,
  ensureRuntimeConfigLoaded,
  evaluateRuntimeConfigDefinition,
  evaluateRuntimeConfigPayload,
  getRuntimeConfig,
  operationalCapsPayloadSchema,
  overrideRuntimeConfig,
  refreshRuntimeConfig,
  resetRuntimeConfig,
  RUNTIME_CONFIG_DEFINITIONS,
  RUNTIME_CONFIG_DISTINCT_ID,
  RUNTIME_CONFIG_FLAG_PATTERN,
  RUNTIME_CONFIG_REFRESH_MS,
  runtimeConfigEnvironment,
  setRuntimeConfigAdapter,
  type RuntimeConfigAdapter,
  type RuntimeConfigDefinition,
} from './index'

const posthogFetcher = (
  body: Record<string, unknown>,
  status = 200,
) => {
  const requests: Array<{ url: string; init: RequestInit; parsedBody: unknown }> = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const resolvedUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    requests.push({
      url: resolvedUrl,
      init: init ?? {},
      parsedBody: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetcher, requests }
}

const VALID_OFFER = {
  id: 'launch-2026-q4',
  kind: 'intro_period' as const,
  planId: 'pro-monthly',
  introAmountCents: 900,
  introInterval: 'month' as const,
  regularAmountCents: 2900,
  regularInterval: 'month' as const,
  introCreditCents: 500,
  stripeCouponId: 'coupon_launch_q4',
  stripeIntroPriceId: 'price_intro_q4',
  startAt: '2026-11-20T00:00:00Z',
  endAt: '2026-12-01T00:00:00Z',
}

beforeEach(() => {
  resetRuntimeConfig()
  clearRuntimeConfigOverrides()
})

test('every RUNTIME_CONFIG_DEFINITIONS entry has unique flag key, metadata, and schema-valid fallback', () => {
  const seenFlags = new Set<string>()
  for (const [key, definition] of Object.entries(RUNTIME_CONFIG_DEFINITIONS)) {
    assert.equal(definition.key, key)
    assert.match(definition.flag, RUNTIME_CONFIG_FLAG_PATTERN, `${key}: invalid flag name`)
    assert.equal(seenFlags.has(definition.flag), false, `${key}: duplicate flag ${definition.flag}`)
    seenFlags.add(definition.flag)
    assert.ok(definition.owner.trim().length > 0, `${key}: owner must be non-empty`)
    assert.ok(definition.description.trim().length > 0, `${key}: description must be non-empty`)
    const parsed = definition.schema.safeParse(definition.fallback)
    assert.equal(parsed.success, true, `${key}: fallback must parse its own schema`)
    assert.deepEqual(parsed.data, definition.fallback, `${key}: fallback should round-trip identically`)
  }
})

test('valid payloads parse from both objects and JSON strings across all definitions', () => {
  const now = Date.parse('2026-11-26T12:00:00Z')

  const banner = evaluateRuntimeConfigPayload(
    'announcementBanner',
    JSON.stringify({
      enabled: true,
      id: 'maintenance-2026-11',
      message: 'Scheduled maintenance tonight',
      href: 'https://status.example.com/incidents/1',
    }),
    { now },
  )
  assert.deepEqual(banner, {
    enabled: true,
    id: 'maintenance-2026-11',
    message: 'Scheduled maintenance tonight',
    href: 'https://status.example.com/incidents/1',
    tone: 'info',
  })

  const offer = evaluateRuntimeConfigPayload('billingActiveOffer', VALID_OFFER, { now })
  assert.deepEqual(offer, VALID_OFFER)

  const caps = evaluateRuntimeConfigPayload(
    'operationalCaps',
    JSON.stringify({ maxWorkspaceBudgets: 500, maxConcurrentRunsOverride: 16 }),
    { now },
  )
  assert.deepEqual(caps, { maxWorkspaceBudgets: 500, maxConcurrentRunsOverride: 16 })

  const entitlements = evaluateRuntimeConfigPayload(
    'planEntitlementOverrides',
    {
      approvalTemplateLimit: { free: 2, pro: 25, enterprise: 100, community: 10 },
      hostedMaxInFlight: { free: 1, pro: 8, enterprise: 32 },
    },
    { now },
  )
  assert.deepEqual(entitlements, {
    approvalTemplateLimit: { free: 2, pro: 25, enterprise: 100, community: 10 },
    hostedMaxInFlight: { free: 1, pro: 8, enterprise: 32 },
  })
})

test('invalid schemas, strict extra fields, unsafe URLs, and malformed JSON fall back safely', () => {
  const now = Date.parse('2026-11-26T12:00:00Z')

  assert.deepEqual(
    evaluateRuntimeConfigPayload('announcementBanner', undefined, { now }),
    RUNTIME_CONFIG_DEFINITIONS.announcementBanner.fallback,
  )
  assert.deepEqual(
    evaluateRuntimeConfigPayload('announcementBanner', '{malformed-json', { now }),
    RUNTIME_CONFIG_DEFINITIONS.announcementBanner.fallback,
  )
  assert.deepEqual(
    evaluateRuntimeConfigPayload('announcementBanner', '', { now }),
    RUNTIME_CONFIG_DEFINITIONS.announcementBanner.fallback,
  )
  // Unknown extra field rejected by .strict()
  assert.deepEqual(
    evaluateRuntimeConfigPayload('announcementBanner', {
      enabled: true,
      id: 'b1',
      message: 'Hi',
      unexpectedField: true,
    }, { now }),
    RUNTIME_CONFIG_DEFINITIONS.announcementBanner.fallback,
  )
  // Unsafe non-http(s) URL rejected
  assert.deepEqual(
    evaluateRuntimeConfigPayload('announcementBanner', {
      enabled: true,
      id: 'b2',
      message: 'Click me',
      href: 'javascript:alert(1)',
    }, { now }),
    RUNTIME_CONFIG_DEFINITIONS.announcementBanner.fallback,
  )
  // Invalid integer / negative caps rejected
  assert.deepEqual(
    evaluateRuntimeConfigPayload('operationalCaps', {
      maxWorkspaceBudgets: 0,
      maxConcurrentRunsOverride: null,
    }, { now }),
    RUNTIME_CONFIG_DEFINITIONS.operationalCaps.fallback,
  )
  assert.deepEqual(
    evaluateRuntimeConfigPayload('operationalCaps', {
      maxWorkspaceBudgets: 10.5,
      maxConcurrentRunsOverride: -1,
    }, { now }),
    RUNTIME_CONFIG_DEFINITIONS.operationalCaps.fallback,
  )
  // Nested strict object rejects unknown tier key
  assert.deepEqual(
    evaluateRuntimeConfigPayload('planEntitlementOverrides', {
      hostedMaxInFlight: { free: 2, unknownTier: 99 },
    }, { now }),
    null,
  )
  // Missing required endAt on billing offer rejected
  const { endAt: _omitted, ...missingEndAt } = VALID_OFFER
  assert.equal(_omitted, VALID_OFFER.endAt)
  assert.equal(evaluateRuntimeConfigPayload('billingActiveOffer', missingEndAt, { now }), null)
})

test('startAt and endAt windows enforce [startAt, endAt) bounds and reject inverted windows', () => {
  const start = Date.parse('2026-11-20T00:00:00Z')
  const mid = Date.parse('2026-11-25T12:00:00Z')
  const end = Date.parse('2026-12-01T00:00:00Z')

  // Before startAt -> fallback
  assert.equal(evaluateRuntimeConfigPayload('billingActiveOffer', VALID_OFFER, { now: start - 1 }), null)
  // Exactly at startAt -> active
  assert.deepEqual(evaluateRuntimeConfigPayload('billingActiveOffer', VALID_OFFER, { now: start }), VALID_OFFER)
  // Inside window -> active
  assert.deepEqual(evaluateRuntimeConfigPayload('billingActiveOffer', VALID_OFFER, { now: mid }), VALID_OFFER)
  // Exactly at endAt -> expired -> fallback
  assert.equal(evaluateRuntimeConfigPayload('billingActiveOffer', VALID_OFFER, { now: end }), null)
  // After endAt -> expired -> fallback
  assert.equal(evaluateRuntimeConfigPayload('billingActiveOffer', VALID_OFFER, { now: end + 60_000 }), null)

  // Inverted window (startAt > endAt) -> fallback even if now is between them
  assert.deepEqual(
    evaluateRuntimeConfigPayload('announcementBanner', {
      enabled: true,
      id: 'inverted',
      message: 'Bad window',
      startAt: '2026-12-05T00:00:00Z',
      endAt: '2026-11-01T00:00:00Z',
    }, { now: mid }),
    RUNTIME_CONFIG_DEFINITIONS.announcementBanner.fallback,
  )

  // Zero-width window (startAt === endAt) -> fallback
  assert.deepEqual(
    evaluateRuntimeConfigPayload('announcementBanner', {
      enabled: true,
      id: 'zero-width',
      message: 'Empty window',
      startAt: '2026-11-25T12:00:00Z',
      endAt: '2026-11-25T12:00:00Z',
    }, { now: mid }),
    RUNTIME_CONFIG_DEFINITIONS.announcementBanner.fallback,
  )

  // Timezone offset ISO datetime support
  const offsetBanner = {
    enabled: true,
    id: 'tz-banner',
    message: 'Offset window',
    startAt: '2026-11-25T08:00:00+08:00', // 00:00:00Z
    endAt: '2026-11-26T08:00:00+08:00',   // 00:00:00Z next day
  }
  assert.equal(
    evaluateRuntimeConfigPayload('announcementBanner', offsetBanner, { now: Date.parse('2026-11-25T12:00:00Z') }).enabled,
    true,
  )
  assert.equal(
    evaluateRuntimeConfigPayload('announcementBanner', offsetBanner, { now: Date.parse('2026-11-26T00:00:00Z') }).enabled,
    false,
  )
})

test('environment mapping and definition environment scoping', () => {
  assert.equal(runtimeConfigEnvironment({ MIKKA_DEPLOYMENT_STAGE: 'production' }), 'production')
  assert.equal(runtimeConfigEnvironment({ MIKKA_DEPLOYMENT_STAGE: 'preview' }), 'preview')
  assert.equal(runtimeConfigEnvironment({ MIKKA_DEPLOYMENT_STAGE: 'development' }), 'local')
  assert.equal(runtimeConfigEnvironment({}), 'local')
  assert.throws(
    () => runtimeConfigEnvironment({ MIKKA_DEPLOYMENT_STAGE: 'staging' }),
    /MIKKA_DEPLOYMENT_STAGE_INVALID/,
  )

  // getRuntimeConfig never throws even with invalid MIKKA_DEPLOYMENT_STAGE
  assert.deepEqual(
    getRuntimeConfig('operationalCaps', { env: { MIKKA_DEPLOYMENT_STAGE: 'staging' } }),
    RUNTIME_CONFIG_DEFINITIONS.operationalCaps.fallback,
  )

  const prodOnlyDef: RuntimeConfigDefinition<typeof operationalCapsPayloadSchema> = {
    key: 'prodOnlyCaps',
    flag: 'mikka-config-prod-only-caps',
    owner: 'platform-ops',
    description: 'Production-only operational caps test definition.',
    environments: ['production'],
    schema: operationalCapsPayloadSchema,
    fallback: { maxWorkspaceBudgets: 200, maxConcurrentRunsOverride: null },
  }

  const candidate = { maxWorkspaceBudgets: 999, maxConcurrentRunsOverride: 42 }
  assert.deepEqual(
    evaluateRuntimeConfigDefinition(prodOnlyDef, candidate, { environment: 'production' }),
    candidate,
  )
  assert.deepEqual(
    evaluateRuntimeConfigDefinition(prodOnlyDef, candidate, { environment: 'preview' }),
    prodOnlyDef.fallback,
  )
  assert.deepEqual(
    evaluateRuntimeConfigDefinition(prodOnlyDef, candidate, { environment: 'local' }),
    prodOnlyDef.fallback,
  )
  assert.deepEqual(
    evaluateRuntimeConfigDefinition(prodOnlyDef, candidate, { environment: null }),
    prodOnlyDef.fallback,
  )

  const localOnlyDef: RuntimeConfigDefinition<typeof operationalCapsPayloadSchema> = {
    key: 'localOnlyCaps',
    flag: 'mikka-config-local-only-caps',
    owner: 'platform-ops',
    description: 'Local-only operational caps test definition.',
    environments: ['local'],
    schema: operationalCapsPayloadSchema,
    fallback: { maxWorkspaceBudgets: 200, maxConcurrentRunsOverride: null },
  }

  assert.deepEqual(
    evaluateRuntimeConfigDefinition(localOnlyDef, candidate, { env: {} }),
    candidate,
  )
  assert.deepEqual(
    evaluateRuntimeConfigDefinition(localOnlyDef, candidate, { env: { MIKKA_DEPLOYMENT_STAGE: 'development' } }),
    candidate,
  )
  // Malformed MIKKA_DEPLOYMENT_STAGE must fail closed to fallback instead of matching 'local'
  assert.deepEqual(
    evaluateRuntimeConfigDefinition(localOnlyDef, candidate, { env: { MIKKA_DEPLOYMENT_STAGE: 'staging' } }),
    localOnlyDef.fallback,
  )
  assert.deepEqual(
    evaluateRuntimeConfigDefinition(localOnlyDef, candidate, { environment: null }),
    localOnlyDef.fallback,
  )
})

test('refreshRuntimeConfig fails closed without fetching when MIKKA_DEPLOYMENT_STAGE is malformed', async () => {
  let called = false
  const adapter: RuntimeConfigAdapter = {
    name: 'spy-malformed-stage',
    async fetchPayloads() {
      called = true
      return {
        'mikka-config-operational-caps': { maxWorkspaceBudgets: 999, maxConcurrentRunsOverride: 10 },
      }
    },
  }

  const ok = await refreshRuntimeConfig({
    adapter,
    env: { MIKKA_DEPLOYMENT_STAGE: 'staging' },
  })
  assert.equal(ok, false)
  assert.equal(called, false)
})

test('PostHog adapter reads flags[k].metadata.payload and flagPayloads, parses stringified JSON, and preserves cache on outages', async () => {
  const now = Date.parse('2026-11-26T12:00:00Z')
  const { fetcher, requests } = posthogFetcher({
    errorsWhileComputingFlags: false,
    flags: {
      'mikka-config-announcement-banner': {
        enabled: true,
        metadata: {
          payload: JSON.stringify({
            enabled: true,
            id: 'banner-from-metadata',
            message: 'From v2 metadata.payload',
            tone: 'warning',
          }),
        },
      },
      'mikka-config-operational-caps': {
        enabled: true,
        metadata: {},
      },
      'mikka-config-plan-entitlement-overrides': {
        enabled: false,
        metadata: {
          payload: JSON.stringify({ hostedMaxInFlight: { free: 99 } }),
        },
      },
    },
    flagPayloads: {
      'mikka-config-announcement-banner': JSON.stringify({
        enabled: true,
        id: 'banner-from-flag-payloads',
        message: 'Should lose to metadata.payload',
      }),
      'mikka-config-operational-caps': JSON.stringify({
        maxWorkspaceBudgets: 350,
        maxConcurrentRunsOverride: 12,
      }),
      'mikka-config-billing-active-offer': VALID_OFFER,
    },
  })

  const adapter = createPostHogRuntimeConfigAdapter({
    token: 'phc_runtime_test',
    apiHost: 'https://eu.i.posthog.com/',
    fetcher,
    timeoutMs: 1_500,
  })

  const refreshed = await refreshRuntimeConfig({
    adapter,
    env: { MIKKA_DEPLOYMENT_STAGE: 'production' },
    now,
  })
  assert.equal(refreshed, true)

  // Verify request contract
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://eu.i.posthog.com/flags?v=2')
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.cache, 'no-store')
  assert.equal(requests[0].init.redirect, 'manual')
  assert.ok(requests[0].init.signal instanceof AbortSignal)
  assert.deepEqual(requests[0].parsedBody, {
    api_key: 'phc_runtime_test',
    distinct_id: RUNTIME_CONFIG_DISTINCT_ID,
    flag_keys_to_evaluate: Object.values(RUNTIME_CONFIG_DEFINITIONS).map(d => d.flag),
    person_properties: { deployment: 'production' },
  })

  // metadata.payload takes precedence over flagPayloads
  assert.deepEqual(getRuntimeConfig('announcementBanner', { env: {}, now }), {
    enabled: true,
    id: 'banner-from-metadata',
    message: 'From v2 metadata.payload',
    tone: 'warning',
  })
  // flagPayloads supplies payload when metadata.payload is absent
  assert.deepEqual(getRuntimeConfig('operationalCaps', { env: {}, now }), {
    maxWorkspaceBudgets: 350,
    maxConcurrentRunsOverride: 12,
  })
  // flagPayloads works with native JSON object too
  assert.deepEqual(getRuntimeConfig('billingActiveOffer', { env: {}, now }), VALID_OFFER)
  // Disabled flag (enabled: false) is ignored even when metadata.payload exists
  assert.equal(getRuntimeConfig('planEntitlementOverrides', { env: {}, now }), null)

  // Outages preserve previously cached answers
  const outageCases: Array<{ label: string; adapter: RuntimeConfigAdapter }> = [
    {
      label: 'HTTP 503',
      adapter: createPostHogRuntimeConfigAdapter({
        token: 'phc_runtime_test',
        fetcher: posthogFetcher({ errorsWhileComputingFlags: false, flags: {} }, 503).fetcher,
      }),
    },
    {
      label: 'HTTP 302 manual redirect',
      adapter: createPostHogRuntimeConfigAdapter({
        token: 'phc_runtime_test',
        fetcher: posthogFetcher({}, 302).fetcher,
      }),
    },
    {
      label: 'errorsWhileComputingFlags=true',
      adapter: createPostHogRuntimeConfigAdapter({
        token: 'phc_runtime_test',
        fetcher: posthogFetcher({ errorsWhileComputingFlags: true, flags: {} }).fetcher,
      }),
    },
    {
      label: 'quotaLimited feature_flags',
      adapter: createPostHogRuntimeConfigAdapter({
        token: 'phc_runtime_test',
        fetcher: posthogFetcher({ errorsWhileComputingFlags: false, quotaLimited: ['feature_flags'], flags: {} }).fetcher,
      }),
    },
    {
      label: 'network error',
      adapter: createPostHogRuntimeConfigAdapter({
        token: 'phc_runtime_test',
        fetcher: (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch,
      }),
    },
    {
      label: 'empty token',
      adapter: createPostHogRuntimeConfigAdapter({
        token: '   ',
        fetcher: (async () => { throw new Error('should not fetch') }) as unknown as typeof fetch,
      }),
    },
  ]

  for (const outage of outageCases) {
    const ok = await refreshRuntimeConfig({ adapter: outage.adapter, env: {}, now })
    assert.equal(ok, false, outage.label)
    assert.equal(
      getRuntimeConfig('announcementBanner', { env: {}, now }).id,
      'banner-from-metadata',
      `${outage.label} must preserve cached banner`,
    )
    assert.equal(
      getRuntimeConfig('operationalCaps', { env: {}, now }).maxWorkspaceBudgets,
      350,
      `${outage.label} must preserve cached caps`,
    )
  }

  // Dynamic expiry on cached payload without needing another refresh
  assert.equal(
    getRuntimeConfig('billingActiveOffer', { env: {}, now: Date.parse('2026-12-01T00:00:00Z') }),
    null,
  )

  // Recovery with empty flagPayloads clears previous remote values cleanly
  const recovered = await refreshRuntimeConfig({
    adapter: createPostHogRuntimeConfigAdapter({
      token: 'phc_runtime_test',
      fetcher: posthogFetcher({ errorsWhileComputingFlags: false, flagPayloads: {} }).fetcher,
    }),
    env: {},
    now,
  })
  assert.equal(recovered, true)
  assert.deepEqual(
    getRuntimeConfig('operationalCaps', { env: {}, now }),
    RUNTIME_CONFIG_DEFINITIONS.operationalCaps.fallback,
  )
})

test('key-value adapter parses JSON strings, handles native values, and survives read errors', async () => {
  const seenKeys: string[][] = []
  const kv = createKeyValueRuntimeConfigAdapter({
    name: 'cloudflare-kv',
    async read(keys) {
      seenKeys.push([...keys])
      return {
        'mikka-config-operational-caps': JSON.stringify({
          maxWorkspaceBudgets: 420,
          maxConcurrentRunsOverride: 24,
        }),
        'mikka-config-announcement-banner': {
          enabled: true,
          id: 'kv-banner',
          message: 'Loaded from KV',
          tone: 'success',
        },
        'mikka-config-billing-active-offer': '{not-valid-json',
        'unrelated-key': { ignored: true },
      }
    },
  })

  assert.equal(kv.name, 'cloudflare-kv')
  setRuntimeConfigAdapter(kv)
  assert.equal(await refreshRuntimeConfig({ env: {} }), true)
  assert.equal(seenKeys.length, 1)

  assert.deepEqual(getRuntimeConfig('operationalCaps', { env: {} }), {
    maxWorkspaceBudgets: 420,
    maxConcurrentRunsOverride: 24,
  })
  assert.deepEqual(getRuntimeConfig('announcementBanner', { env: {} }), {
    enabled: true,
    id: 'kv-banner',
    message: 'Loaded from KV',
    tone: 'success',
  })
  // Malformed JSON string in KV falls back cleanly
  assert.equal(getRuntimeConfig('billingActiveOffer', { env: {} }), null)

  // KV outage preserves cached values
  const failingKv = createKeyValueRuntimeConfigAdapter({
    name: 'failing-kv',
    async read() {
      throw new Error('KV unavailable')
    },
  })
  assert.equal(await refreshRuntimeConfig({ adapter: failingKv, env: {} }), false)
  assert.equal(getRuntimeConfig('operationalCaps', { env: {} }).maxWorkspaceBudgets, 420)
})

test('composite adapter enforces precedence, falls through on null/missing/errors, and returns null on total outage', async () => {
  const now = Date.parse('2026-11-26T12:00:00Z')
  const primary = createKeyValueRuntimeConfigAdapter({
    name: 'kv-override',
    async read() {
      return {
        'mikka-config-operational-caps': { maxWorkspaceBudgets: 777, maxConcurrentRunsOverride: 10 },
        // Explicit null falls through to secondary's non-null payload
        'mikka-config-billing-active-offer': null,
      }
    },
  })
  const secondary = createPostHogRuntimeConfigAdapter({
    token: 'phc_test',
    fetcher: posthogFetcher({
      errorsWhileComputingFlags: false,
      flagPayloads: {
        'mikka-config-operational-caps': JSON.stringify({ maxWorkspaceBudgets: 111, maxConcurrentRunsOverride: 2 }),
        'mikka-config-billing-active-offer': JSON.stringify(VALID_OFFER),
        'mikka-config-announcement-banner': JSON.stringify({
          enabled: true,
          id: 'secondary-banner',
          message: 'From secondary',
        }),
      },
    }).fetcher,
  })

  const composite = createCompositeRuntimeConfigAdapter([primary, secondary])
  assert.equal(composite.name, 'composite(kv-override,posthog)')
  assert.equal(await refreshRuntimeConfig({ adapter: composite, env: {}, now }), true)

  // Primary wins on operationalCaps
  assert.deepEqual(getRuntimeConfig('operationalCaps', { env: {}, now }), {
    maxWorkspaceBudgets: 777,
    maxConcurrentRunsOverride: 10,
  })
  // Primary's null falls through to secondary's offer
  assert.deepEqual(getRuntimeConfig('billingActiveOffer', { env: {}, now }), VALID_OFFER)
  // Primary's missing key falls through to secondary's banner
  assert.equal(getRuntimeConfig('announcementBanner', { env: {}, now }).id, 'secondary-banner')

  // Primary fails (returns null) -> secondary alone still succeeds
  const failingPrimary: RuntimeConfigAdapter = {
    name: 'broken-primary',
    async fetchPayloads() {
      return null
    },
  }
  const fallbackComposite = createCompositeRuntimeConfigAdapter([failingPrimary, secondary])
  assert.equal(await refreshRuntimeConfig({ adapter: fallbackComposite, env: {}, now }), true)
  assert.equal(getRuntimeConfig('operationalCaps', { env: {}, now }).maxWorkspaceBudgets, 111)

  // Total outage (all adapters fail or throw) -> returns null and preserves previous cache
  const throwingAdapter: RuntimeConfigAdapter = {
    name: 'throwing',
    async fetchPayloads() {
      throw new Error('boom')
    },
  }
  const totalOutage = createCompositeRuntimeConfigAdapter([failingPrimary, throwingAdapter])
  assert.equal(await refreshRuntimeConfig({ adapter: totalOutage, env: {}, now }), false)
  assert.equal(getRuntimeConfig('operationalCaps', { env: {}, now }).maxWorkspaceBudgets, 111)
})

test('overrideRuntimeConfig wins over remote, supports explicit null, clears cleanly, validates schema, and is unreachable in production', async () => {
  const now = Date.parse('2026-11-26T12:00:00Z')
  await refreshRuntimeConfig({
    adapter: createKeyValueRuntimeConfigAdapter({
      async read() {
        return {
          'mikka-config-operational-caps': { maxWorkspaceBudgets: 300, maxConcurrentRunsOverride: 5 },
          'mikka-config-billing-active-offer': VALID_OFFER,
        }
      },
    }),
    env: {},
    now,
  })

  overrideRuntimeConfig('operationalCaps', { maxWorkspaceBudgets: 50, maxConcurrentRunsOverride: 2 })
  overrideRuntimeConfig('billingActiveOffer', null)

  assert.deepEqual(getRuntimeConfig('operationalCaps', { env: {}, now }), {
    maxWorkspaceBudgets: 50,
    maxConcurrentRunsOverride: 2,
  })
  // Explicit null override must win over cached remote non-null offer
  assert.equal(getRuntimeConfig('billingActiveOffer', { env: {}, now }), null)

  // Stored on the well-known globalThis symbol
  const symbolMap = (globalThis as Record<symbol, Map<string, unknown> | undefined>)[
    Symbol.for('mikka.runtimeConfigOverrides')
  ]
  assert.ok(symbolMap instanceof Map)
  assert.equal(symbolMap.has('operationalCaps'), true)
  assert.equal(symbolMap.has('billingActiveOffer'), true)

  // Invalid override value throws ZodError
  assert.throws(() => {
    overrideRuntimeConfig('operationalCaps', {
      maxWorkspaceBudgets: -5,
      maxConcurrentRunsOverride: null,
    })
  })

  // Clearing single key restores remote value
  overrideRuntimeConfig('operationalCaps', undefined)
  assert.deepEqual(getRuntimeConfig('operationalCaps', { env: {}, now }), {
    maxWorkspaceBudgets: 300,
    maxConcurrentRunsOverride: 5,
  })
  assert.equal(getRuntimeConfig('billingActiveOffer', { env: {}, now }), null)

  // Clearing all overrides restores remaining remote values
  clearRuntimeConfigOverrides()
  assert.deepEqual(getRuntimeConfig('billingActiveOffer', { env: {}, now }), VALID_OFFER)

  // Production / deployment / malformed-stage guards throw and leave overrides untouched
  const blockedEnvs = [
    { NODE_ENV: 'production' },
    { MIKKA_DEPLOYMENT_STAGE: 'production' },
    { MIKKA_DEPLOYMENT_STAGE: 'preview' },
    { MIKKA_DEPLOYMENT_STAGE: 'development' },
    { MIKKA_DEPLOYMENT_STAGE: 'staging' },
  ]
  for (const env of blockedEnvs) {
    assert.throws(
      () => overrideRuntimeConfig('operationalCaps', { maxWorkspaceBudgets: 1, maxConcurrentRunsOverride: 1 }, env),
      /overrideRuntimeConfig is for tests only/,
      JSON.stringify(env),
    )
    assert.throws(
      () => clearRuntimeConfigOverrides(env),
      /overrideRuntimeConfig is for tests only/,
      JSON.stringify(env),
    )
  }
  assert.equal(getRuntimeConfig('operationalCaps', { env: {}, now }).maxWorkspaceBudgets, 300)

  // Even when an override exists in tests, getRuntimeConfig never returns it for production/deployed/malformed env
  overrideRuntimeConfig('operationalCaps', { maxWorkspaceBudgets: 77, maxConcurrentRunsOverride: 3 })
  assert.equal(getRuntimeConfig('operationalCaps', { env: {}, now }).maxWorkspaceBudgets, 77)
  for (const env of blockedEnvs) {
    assert.equal(
      getRuntimeConfig('operationalCaps', { env, now }).maxWorkspaceBudgets,
      300,
      `getRuntimeConfig must ignore test overrides for ${JSON.stringify(env)}`,
    )
  }
  clearRuntimeConfigOverrides()

  // Verify no production file imports or references overrideRuntimeConfig
  const files = execFileSync(
    'git',
    ['grep', '-l', '--untracked', 'overrideRuntimeConfig', '--', '.', ':!docs'],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean)
  const productionFiles = files.filter(
    file =>
      file !== 'lib/runtime-config/index.ts'
      && !/(\.test|\.db)\.(ts|mts|mjs)$/.test(file)
      && !file.startsWith('tests/'),
  )
  assert.deepEqual(productionFiles, [])
})

test('overrideRuntimeConfig enforces live runtimeEnv guards even when empty env is passed and ignores overrides in getRuntimeConfig', () => {
  const moduleUrl = new URL('./index.ts', import.meta.url).href
  const liveBlockedCases: Array<Record<string, string>> = [
    { NODE_ENV: 'production' },
    { MIKKA_DEPLOYMENT_STAGE: 'production' },
    { MIKKA_DEPLOYMENT_STAGE: 'preview' },
    { MIKKA_DEPLOYMENT_STAGE: 'development' },
    { MIKKA_DEPLOYMENT_STAGE: 'staging' },
  ]

  const baseEnv: Record<string, string | undefined> = { ...process.env }
  delete baseEnv.NODE_ENV
  delete baseEnv.MIKKA_DEPLOYMENT_STAGE
  delete baseEnv.MIKKA_DEPLOYMENT_ENVIRONMENT

  const script = `
    import assert from 'node:assert/strict'
    import {
      clearRuntimeConfigOverrides,
      evaluateRuntimeConfigDefinition,
      getRuntimeConfig,
      operationalCapsPayloadSchema,
      overrideRuntimeConfig,
      RUNTIME_CONFIG_DEFINITIONS,
    } from ${JSON.stringify(moduleUrl)}

    assert.throws(
      () => overrideRuntimeConfig('operationalCaps', { maxWorkspaceBudgets: 1, maxConcurrentRunsOverride: 1 }, {}),
      /overrideRuntimeConfig is for tests only/,
    )
    assert.throws(
      () => clearRuntimeConfigOverrides({}),
      /overrideRuntimeConfig is for tests only/,
    )

    // Even if the globalThis override map is tampered with directly, getRuntimeConfig must ignore it
    globalThis[Symbol.for('mikka.runtimeConfigOverrides')] = new Map([
      ['operationalCaps', { maxWorkspaceBudgets: 1, maxConcurrentRunsOverride: 1 }],
    ])
    assert.deepEqual(getRuntimeConfig('operationalCaps'), RUNTIME_CONFIG_DEFINITIONS.operationalCaps.fallback)
    assert.deepEqual(getRuntimeConfig('operationalCaps', { env: {} }), RUNTIME_CONFIG_DEFINITIONS.operationalCaps.fallback)

    if (process.env.MIKKA_DEPLOYMENT_STAGE === 'staging') {
      const localOnly = {
        key: 'localOnly',
        flag: 'mikka-config-local-only',
        owner: 'platform-ops',
        description: 'Local-only test def',
        environments: ['local'],
        schema: operationalCapsPayloadSchema,
        fallback: { maxWorkspaceBudgets: 200, maxConcurrentRunsOverride: null },
      }
      assert.deepEqual(
        evaluateRuntimeConfigDefinition(localOnly, { maxWorkspaceBudgets: 999, maxConcurrentRunsOverride: 5 }),
        localOnly.fallback,
      )
    }
  `

  for (const extraEnv of liveBlockedCases) {
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: { ...baseEnv, ...extraEnv },
      stdio: 'pipe',
    })
  }
})

test('overrideRuntimeConfig respects [startAt, endAt) windows and falls back to definition.fallback when expired or future', async () => {
  const start = Date.parse('2026-11-20T00:00:00Z')
  const mid = Date.parse('2026-11-25T12:00:00Z')
  const end = Date.parse('2026-12-01T00:00:00Z')

  // Seed cached remote payloads to verify expired overrides fall back to definition.fallback (not stale remote cache)
  await refreshRuntimeConfig({
    adapter: createKeyValueRuntimeConfigAdapter({
      async read() {
        return {
          'mikka-config-announcement-banner': {
            enabled: true,
            id: 'remote-banner',
            message: 'Cached remote banner',
            tone: 'info',
          },
          'mikka-config-billing-active-offer': VALID_OFFER,
        }
      },
    }),
    env: {},
    now: mid,
  })

  overrideRuntimeConfig('billingActiveOffer', VALID_OFFER)
  assert.equal(getRuntimeConfig('billingActiveOffer', { env: {}, now: start - 1 }), null)
  assert.deepEqual(getRuntimeConfig('billingActiveOffer', { env: {}, now: start }), VALID_OFFER)
  assert.deepEqual(getRuntimeConfig('billingActiveOffer', { env: {}, now: mid }), VALID_OFFER)
  assert.equal(getRuntimeConfig('billingActiveOffer', { env: {}, now: end }), null)
  assert.equal(getRuntimeConfig('billingActiveOffer', { env: {}, now: end + 60_000 }), null)

  overrideRuntimeConfig('announcementBanner', {
    enabled: true,
    id: 'timed-override-banner',
    message: 'Limited time notice',
    startAt: '2026-11-20T00:00:00Z',
    endAt: '2026-11-21T00:00:00Z',
  })
  assert.equal(getRuntimeConfig('announcementBanner', { env: {}, now: Date.parse('2026-11-20T12:00:00Z') }).enabled, true)
  assert.deepEqual(
    getRuntimeConfig('announcementBanner', { env: {}, now: Date.parse('2026-11-21T00:00:00Z') }),
    RUNTIME_CONFIG_DEFINITIONS.announcementBanner.fallback,
  )
  assert.deepEqual(
    getRuntimeConfig('announcementBanner', { env: {}, now: Date.parse('2026-11-22T00:00:00Z') }),
    RUNTIME_CONFIG_DEFINITIONS.announcementBanner.fallback,
  )

  // Inverted window override also falls back cleanly
  overrideRuntimeConfig('announcementBanner', {
    enabled: true,
    id: 'inverted-override',
    message: 'Invalid window',
    startAt: '2026-12-01T00:00:00Z',
    endAt: '2026-11-01T00:00:00Z',
  })
  assert.deepEqual(
    getRuntimeConfig('announcementBanner', { env: {}, now: mid }),
    RUNTIME_CONFIG_DEFINITIONS.announcementBanner.fallback,
  )
})

test('getRuntimeConfig schedules throttled background refresh only for default runtimeEnv without blocking', async () => {
  let calls = 0
  setRuntimeConfigAdapter({
    name: 'spy-adapter',
    async fetchPayloads() {
      calls += 1
      return {
        'mikka-config-operational-caps': {
          maxWorkspaceBudgets: 200 + calls,
          maxConcurrentRunsOverride: calls,
        },
      }
    },
  })

  // Explicit injected env does NOT trigger background refresh
  assert.deepEqual(
    getRuntimeConfig('operationalCaps', { env: {}, now: 1_000 }),
    RUNTIME_CONFIG_DEFINITIONS.operationalCaps.fallback,
  )
  await Promise.resolve()
  assert.equal(calls, 0)

  // Default runtimeEnv triggers one background refresh and returns fallback synchronously
  assert.deepEqual(
    getRuntimeConfig('operationalCaps', { now: 1_000 }),
    RUNTIME_CONFIG_DEFINITIONS.operationalCaps.fallback,
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.deepEqual(getRuntimeConfig('operationalCaps', { now: 2_000 }), {
    maxWorkspaceBudgets: 201,
    maxConcurrentRunsOverride: 1,
  })
  // Still within RUNTIME_CONFIG_REFRESH_MS -> no second call
  assert.equal(calls, 1)

  // Once RUNTIME_CONFIG_REFRESH_MS elapses, next read schedules a refresh
  assert.equal(
    getRuntimeConfig('operationalCaps', { now: 1_000 + RUNTIME_CONFIG_REFRESH_MS }).maxWorkspaceBudgets,
    201,
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 2)
  assert.equal(
    getRuntimeConfig('operationalCaps', { now: 1_000 + RUNTIME_CONFIG_REFRESH_MS + 10 }).maxWorkspaceBudgets,
    202,
  )
})

test('ensureRuntimeConfigLoaded performs single-flight cold load, skips when warm or unconfigured, and throttles outages', async () => {
  // Unconfigured (no adapter, no PostHog key) returns false immediately with zero I/O.
  assert.equal(await ensureRuntimeConfigLoaded({ env: {}, now: 1_000 }), false)

  let calls = 0
  let releaseFetch!: () => void
  const gate = new Promise<void>(resolve => { releaseFetch = resolve })
  setRuntimeConfigAdapter({
    name: 'deferred-cold-adapter',
    async fetchPayloads() {
      calls += 1
      await gate
      return {
        'mikka-config-billing-active-offer': VALID_OFFER,
      }
    },
  })

  const activeNow = Date.parse('2026-11-26T12:00:00Z')
  const first = ensureRuntimeConfigLoaded({ env: {}, now: activeNow })
  const second = ensureRuntimeConfigLoaded({ env: {}, now: activeNow + 5 })
  releaseFetch()
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  assert.equal(calls, 1)
  assert.deepEqual(getRuntimeConfig('billingActiveOffer', { env: {}, now: activeNow }), VALID_OFFER)

  // Warm within RUNTIME_CONFIG_REFRESH_MS -> zero additional fetches.
  assert.equal(await ensureRuntimeConfigLoaded({ env: {}, now: activeNow + RUNTIME_CONFIG_REFRESH_MS - 1 }), true)
  assert.equal(calls, 1)

  // Past RUNTIME_CONFIG_REFRESH_MS -> refreshes cleanly.
  assert.equal(await ensureRuntimeConfigLoaded({ env: {}, now: activeNow + RUNTIME_CONFIG_REFRESH_MS }), true)
  assert.equal(calls, 2)

  // Outage throttles retries for RUNTIME_CONFIG_REFRESH_MS even when a concurrent caller passes a slightly earlier now.
  resetRuntimeConfig()
  let outageCalls = 0
  setRuntimeConfigAdapter({
    name: 'outage-adapter',
    async fetchPayloads() {
      outageCalls += 1
      return null
    },
  })
  assert.equal(await ensureRuntimeConfigLoaded({ env: {}, now: 5_000 }), false)
  assert.equal(await ensureRuntimeConfigLoaded({ env: {}, now: 5_010 }), false)
  assert.equal(await ensureRuntimeConfigLoaded({ env: {}, now: 4_950 }), false)
  assert.equal(outageCalls, 1)
  assert.equal(await ensureRuntimeConfigLoaded({ env: {}, now: 5_000 + RUNTIME_CONFIG_REFRESH_MS }), false)
  assert.equal(outageCalls, 2)

  // Malformed MIKKA_DEPLOYMENT_STAGE must not poison state.at or throttle a subsequent valid cold-start load.
  resetRuntimeConfig()
  let validCalls = 0
  setRuntimeConfigAdapter({
    name: 'valid-after-malformed-adapter',
    async fetchPayloads() {
      validCalls += 1
      return { 'mikka-config-billing-active-offer': VALID_OFFER }
    },
  })
  assert.equal(await ensureRuntimeConfigLoaded({ env: { MIKKA_DEPLOYMENT_STAGE: 'staging' }, now: activeNow }), false)
  assert.equal(validCalls, 0)
  assert.equal(await ensureRuntimeConfigLoaded({ env: {}, now: activeNow + 1 }), true)
  assert.equal(validCalls, 1)
  // A slightly earlier timestamp after a fresher successful load stays warm and does not re-fetch.
  assert.equal(await ensureRuntimeConfigLoaded({ env: {}, now: activeNow - 500 }), true)
  assert.equal(validCalls, 1)
})

test('billingActiveOfferPayloadSchema trims offer IDs and rejects whitespace-only or >120-char IDs (audit label limit)', () => {
  const now = Date.parse('2026-11-26T12:00:00Z')
  assert.equal(
    evaluateRuntimeConfigPayload('billingActiveOffer', { ...VALID_OFFER, id: '  promo-trimmed  ' }, { now })?.id,
    'promo-trimmed',
  )
  assert.equal(
    evaluateRuntimeConfigPayload('billingActiveOffer', { ...VALID_OFFER, id: '   ' }, { now }),
    null,
  )
  assert.equal(
    evaluateRuntimeConfigPayload('billingActiveOffer', { ...VALID_OFFER, id: 'a'.repeat(120) }, { now })?.id,
    'a'.repeat(120),
  )
  assert.equal(
    evaluateRuntimeConfigPayload('billingActiveOffer', { ...VALID_OFFER, id: 'a'.repeat(121) }, { now }),
    null,
  )
})
