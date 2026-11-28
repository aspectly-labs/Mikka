import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'
import { LEGACY_PUBLIC_ENV, legacyPublicName, publicEnv, withLegacyPublicDefines, withLegacyPublicNames } from './public-env.mjs'

const root = resolve(import.meta.dirname, '..')
const NEW = 'MIKKA_PUBLIC_POSTHOG_KEY'
const OLD = LEGACY_PUBLIC_ENV[NEW]

test('the legacy table maps each new name to one NEXT_PUBLIC_* name', () => {
  const legacy = Object.values(LEGACY_PUBLIC_ENV)
  assert.equal(new Set(legacy).size, legacy.length)
  for (const [name, previous] of Object.entries(LEGACY_PUBLIC_ENV)) {
    assert.match(previous, /^NEXT_PUBLIC_[A-Z0-9_]+$/)
    assert.doesNotMatch(name, /^NEXT_/)
    assert.equal(legacyPublicName(name), previous)
  }
  assert.ok(Object.isFrozen(LEGACY_PUBLIC_ENV))
  assert.equal(legacyPublicName('MIKKA_BUILD_REVISION'), undefined)
  assert.equal(legacyPublicName('toString'), undefined)
})

test('publicEnv prefers the new name', () => {
  assert.equal(publicEnv(NEW, { [NEW]: 'current', [OLD]: 'legacy' }), 'current')
})

test('an empty value counts as unset under either name', () => {
  assert.equal(publicEnv(NEW, { [NEW]: '', [OLD]: 'legacy' }, 'default'), 'legacy')
  assert.equal(publicEnv(NEW, { [NEW]: '', [OLD]: '' }, 'default'), 'default')
  assert.equal(publicEnv(NEW, { [NEW]: '' }), undefined)
  // The PostHog host and the Stripe key, as Devin's review cases.
  assert.equal(publicEnv('POSTHOG_HOST', { POSTHOG_HOST: '', NEXT_PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com' }, 'https://us.i.posthog.com'), 'https://eu.i.posthog.com')
  assert.equal(publicEnv('MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY', { MIKKA_PUBLIC_STRIPE_PUBLISHABLE_KEY: '', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_legacy' }), 'pk_test_legacy')
})

test('the server PostHog configuration falls back to the legacy host and key when the new names are empty', () => {
  const env = { ...process.env, POSTHOG_HOST: '', NEXT_PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com/', MIKKA_PUBLIC_POSTHOG_KEY: '', NEXT_PUBLIC_POSTHOG_KEY: 'phc_legacy_fixture' }
  const read = env => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    'import { posthogConfig } from "./lib/posthog-config.ts"; console.log(JSON.stringify(posthogConfig))'], { cwd: root, env, encoding: 'utf8' }))
  assert.deepEqual([read(env).apiHost, read(env).token], ['https://eu.i.posthog.com', 'phc_legacy_fixture'])
  const unset = { ...env, NEXT_PUBLIC_POSTHOG_HOST: '', NEXT_PUBLIC_POSTHOG_KEY: '' }
  assert.deepEqual([read(unset).apiHost, read(unset).token], ['https://us.i.posthog.com', ''])
})

test('publicEnv falls back to the legacy name', () => {
  assert.equal(publicEnv(NEW, { [OLD]: 'legacy' }), 'legacy')
  assert.equal(publicEnv(NEW, { [OLD]: 'legacy' }, 'default'), 'legacy')
  assert.equal(publicEnv(NEW, { [OLD]: '' }, 'default'), 'default')
})

test('publicEnv returns the default otherwise', () => {
  assert.equal(publicEnv(NEW, {}), undefined)
  assert.equal(publicEnv(NEW, {}, 'default'), 'default')
  assert.equal(publicEnv(NEW, { UNRELATED: 'value' }, ''), '')
})

test('publicEnv reads the process environment by default', () => {
  const saved = [process.env[NEW], process.env[OLD]]
  try {
    delete process.env[NEW]
    process.env[OLD] = 'process-legacy'
    assert.equal(publicEnv(NEW), 'process-legacy')
    process.env[NEW] = 'process-current'
    assert.equal(publicEnv(NEW), 'process-current')
  } finally {
    for (const [index, name] of [NEW, OLD].entries()) {
      if (saved[index] === undefined) delete process.env[name]
      else process.env[name] = saved[index]
    }
  }
})

test('allowlists and bundler replacements carry each legacy name beside its new one', () => {
  assert.deepEqual(withLegacyPublicNames(['PATH', NEW]), ['PATH', NEW, OLD])
  assert.deepEqual(withLegacyPublicDefines({ 'process.env.NODE_ENV': '"production"', [`process.env.${NEW}`]: '"key"' }),
    { 'process.env.NODE_ENV': '"production"', [`process.env.${NEW}`]: '"key"', [`process.env.${OLD}`]: '"key"' })
})
