import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_LOCAL_APP_ORIGIN,
  DEFAULT_LOCAL_DEV_ORIGIN,
  DEFAULT_LOCAL_EVE_ORIGIN,
  INTERNAL_PRODUCT_ORIGIN,
  isLoopbackHost,
  isLoopbackHttpOrigin,
  loopbackUrl,
  resolveEveProxyOrigin,
  resolveEveServerEndpoint,
  resolveInternalProductOrigin,
  resolveLocalAppOrigin,
  resolveLocalDevOrigin,
  syntheticLocalRequest,
} from './hosts'
import {
  DEFAULT_POSTHOG_API_HOST,
  getPublicBasePath,
  getPublicPosthogHost,
  getPublicPosthogKey,
  getPublicTurnstileSiteKey,
  isProductionEnv,
  readPublicEnv,
} from './public'
import {
  envBool,
  envExact,
  envInt,
  envList,
  envNumber,
  envRequired,
  envSnapshot,
  envString,
  envUrl,
  parseServerEnv,
  readEnv,
} from './server'

test('server env helpers validate shapes and accept injected Env maps without mutating process.env', () => {
  const env = {
    NODE_ENV: 'production',
    MIKKA_EDITION: ' cloud ',
    MIKKA_DEPLOYMENT_STAGE: 'production',
    MIKKA_APP_ORIGIN: 'https://app.example.com',
    FLAG_ON: 'true',
    FLAG_OFF: '0',
    PORT_NUM: '8080',
    RATIO: '0.25',
    ITEMS: ' alpha, beta , , gamma ',
    BLANK: '   ',
  }
  const parsed = parseServerEnv(env)
  assert.equal(parsed.NODE_ENV, 'production')
  assert.equal(parsed.MIKKA_EDITION, 'cloud')
  assert.equal(parsed.MIKKA_DEPLOYMENT_STAGE, 'production')
  assert.equal(parsed.MIKKA_APP_ORIGIN, 'https://app.example.com')

  assert.equal(readEnv('BLANK', env), '   ')
  assert.equal(envString('BLANK', env), undefined)
  assert.equal(envString('MIKKA_APP_ORIGIN', env), 'https://app.example.com')
  assert.equal(envRequired('MIKKA_APP_ORIGIN', env), 'https://app.example.com')
  assert.throws(() => envRequired('MISSING_SECRET_NAME', env), /MISSING_SECRET_NAME/)
  assert.equal(envExact('FLAG_OFF', '0', env), true)
  assert.equal(envBool('FLAG_ON', false, env), true)
  assert.equal(envBool('FLAG_OFF', true, env), false)
  assert.equal(envBool('MISSING', true, env), true)
  assert.equal(envInt('PORT_NUM', 3000, { min: 1, max: 65535 }, env), 8080)
  assert.equal(envInt('PORT_NUM', 3000, { max: 1024 }, env), 3000)
  assert.equal(envNumber('RATIO', 0.5, { min: 0, max: 1 }, env), 0.25)
  assert.deepEqual(envList('ITEMS', env), ['alpha', 'beta', 'gamma'])
  assert.equal(envUrl('MIKKA_APP_ORIGIN', env), 'https://app.example.com')
  assert.equal(envUrl('MISSING_URL', env), undefined)

  // N1: envUrl wraps Zod parse failures with variable name, preserves cause, and never leaks secret URL values
  for (const [varName, badValue] of [
    ['SECRET_UPSTREAM_URL', 'ftp://user:super_secret_token@example.com'],
    ['SECRET_WEBHOOK_URL', 'not-a-url-super_secret_token'],
  ] as const) {
    assert.throws(
      () => envUrl(varName, { [varName]: badValue }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.equal(err.message, `Invalid URL in environment variable: ${varName}`)
        assert.ok(err.cause instanceof Error)
        assert.equal(err.message.includes('super_secret_token'), false)
        assert.equal(String(err.cause).includes('super_secret_token'), false)
        return true
      },
    )
  }

  // N1: MIKKA_EDITION is case-sensitive (matching lib/edition.ts)
  assert.equal(parseServerEnv({ MIKKA_EDITION: ' community ' }).MIKKA_EDITION, 'community')
  assert.throws(() => parseServerEnv({ MIKKA_EDITION: 'CLOUD' }))
  assert.throws(() => parseServerEnv({ MIKKA_EDITION: 'Community' }))
  assert.throws(() => parseServerEnv({ MIKKA_EDITION: 'invalid' }))
  assert.equal(envSnapshot({ EXTRA: '1' }, env).EXTRA, '1')
  assert.equal('EXTRA' in env, false)
})

test('public env boundary validates public settings and preserves legacy NEXT_PUBLIC fallback', () => {
  const env = {
    NODE_ENV: 'production',
    MIKKA_BASE_PATH: '/mikka',
    MIKKA_PUBLIC_POSTHOG_KEY: 'phc_new',
    POSTHOG_HOST: 'https://eu.i.posthog.com/',
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'turnstile_legacy',
  }
  const parsed = readPublicEnv(env)
  assert.equal(parsed.NODE_ENV, 'production')
  assert.equal(parsed.MIKKA_BASE_PATH, '/mikka')
  assert.equal(parsed.MIKKA_PUBLIC_POSTHOG_KEY, 'phc_new')
  assert.equal(parsed.POSTHOG_HOST, 'https://eu.i.posthog.com')
  assert.equal(parsed.MIKKA_PUBLIC_TURNSTILE_SITE_KEY, 'turnstile_legacy')
  assert.equal(parsed.MIKKA_DAEMON_PACKAGE_NAME, '@aspectlylabs/mikka')
  assert.equal(getPublicBasePath(env), '/mikka')
  assert.equal(getPublicPosthogKey(env), 'phc_new')
  assert.equal(getPublicPosthogHost(env), 'https://eu.i.posthog.com')
  assert.equal(getPublicPosthogHost({}), DEFAULT_POSTHOG_API_HOST)
  // N2: getPublicPosthogHost trims whitespace and falls back on blank or invalid http(s) URLs
  assert.equal(getPublicPosthogHost({ POSTHOG_HOST: '  https://eu.i.posthog.com///  ' }), 'https://eu.i.posthog.com')
  assert.equal(getPublicPosthogHost({ POSTHOG_HOST: 'https://eu.i.posthog.com/ingest/' }), 'https://eu.i.posthog.com/ingest')
  assert.equal(getPublicPosthogHost({ POSTHOG_HOST: '' }), DEFAULT_POSTHOG_API_HOST)
  assert.equal(getPublicPosthogHost({ POSTHOG_HOST: '   ' }), DEFAULT_POSTHOG_API_HOST)
  assert.equal(getPublicPosthogHost({ POSTHOG_HOST: '///' }), DEFAULT_POSTHOG_API_HOST)
  assert.equal(getPublicPosthogHost({ POSTHOG_HOST: 'https:///' }), DEFAULT_POSTHOG_API_HOST)
  assert.equal(getPublicPosthogHost({ POSTHOG_HOST: 'ftp://eu.i.posthog.com' }), DEFAULT_POSTHOG_API_HOST)
  assert.equal(getPublicPosthogHost({ POSTHOG_HOST: 'javascript:alert(1)' }), DEFAULT_POSTHOG_API_HOST)
  assert.equal(getPublicPosthogHost({ POSTHOG_HOST: 'not a valid url' }), DEFAULT_POSTHOG_API_HOST)
  assert.equal(getPublicTurnstileSiteKey(env), 'turnstile_legacy')
  assert.equal(isProductionEnv(env), true)
  assert.equal(isProductionEnv({ NODE_ENV: 'development' }), false)
})

test('hosts boundary validates loopback checks and resolves local/internal origins deterministically', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('[::1]'), true)
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isLoopbackHost('sub.localhost'), false)
  assert.equal(isLoopbackHost('sub.localhost', { allowSubdomain: true }), true)
  assert.equal(isLoopbackHost('a.localhost', { allowSubdomain: true }), true)
  assert.equal(isLoopbackHost('a-b.c-d.localhost', { allowSubdomain: true }), true)
  assert.equal(isLoopbackHost('SUB.LOCALHOST', { allowSubdomain: true }), true)
  assert.equal(isLoopbackHost(`${'a'.repeat(63)}.localhost`, { allowSubdomain: true }), true)
  // Exact RFC 1035 253-character hostname boundary: 253 valid, 254 rejected
  assert.equal(
    isLoopbackHost(
      `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.localhost`,
      { allowSubdomain: true },
    ),
    true,
  )
  // N2: malformed *.localhost subdomains must be rejected
  for (const invalidSubdomain of [
    '.localhost',
    '..localhost',
    'a..localhost',
    '-sub.localhost',
    'sub-.localhost',
    'evil.com/.localhost',
    'evil.com?.localhost',
    'evil.com#.localhost',
    'evil.com@.localhost',
    'sub.localhost:3000',
    'sub.localhost.',
    'sub_name.localhost',
    `${'a'.repeat(64)}.localhost`,
    `${'a'.repeat(61)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.localhost`,
  ]) {
    assert.equal(
      isLoopbackHost(invalidSubdomain, { allowSubdomain: true }),
      false,
      `expected false for ${invalidSubdomain}`,
    )
  }
  assert.equal(isLoopbackHost('example.com'), false)

  assert.equal(isLoopbackHttpOrigin('http://127.0.0.1:3000'), true)
  assert.equal(isLoopbackHttpOrigin('http://localhost:3000'), true)
  assert.equal(isLoopbackHttpOrigin('https://127.0.0.1:3000'), false)
  assert.equal(isLoopbackHttpOrigin('http://example.com:3000'), false)

  assert.equal(resolveLocalAppOrigin({}), DEFAULT_LOCAL_APP_ORIGIN)
  assert.equal(resolveLocalAppOrigin({ MIKKA_APP_ORIGIN: 'https://mikka.example.com/path' }), 'https://mikka.example.com')
  assert.equal(resolveLocalDevOrigin({}), DEFAULT_LOCAL_DEV_ORIGIN)
  assert.equal(resolveInternalProductOrigin(true, {}), INTERNAL_PRODUCT_ORIGIN)
  assert.equal(resolveInternalProductOrigin(false, {}), DEFAULT_LOCAL_APP_ORIGIN)
  assert.equal(resolveEveProxyOrigin({}), DEFAULT_LOCAL_EVE_ORIGIN)
  assert.equal(resolveEveProxyOrigin({ MIKKA_EVE_ORIGIN: 'https://eve.example.com' }), 'https://eve.example.com')
  assert.equal(resolveEveServerEndpoint({}), `${DEFAULT_LOCAL_APP_ORIGIN}/mikka/api/agents`)
  assert.equal(loopbackUrl(4123, '/return'), 'http://127.0.0.1:4123/return')
  assert.equal(new URL(syntheticLocalRequest('/api/mcp').url).pathname, '/api/mcp')
})
