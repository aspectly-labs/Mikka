import assert from 'node:assert/strict'
import test from 'node:test'
import { applicationEnvironment } from './ingress/environment.mjs'

const OPEN_ARTIFACT_VARS = [
  'OPEN_ARTIFACT_HOST_ORIGIN',
  'OPEN_ARTIFACT_BRIDGE_SECRET',
  'OPEN_ARTIFACT_ENABLED_TYPES',
  'OPEN_ARTIFACT_EMBED_ORIGINS',
]

test('applicationEnvironment forwards all non-empty OPEN_ARTIFACT_* bindings', () => {
  const bindings = {
    PUBLIC_ORIGIN: 'https://app.example',
    OPEN_ARTIFACT_HOST_ORIGIN: 'https://artifacts.example',
    OPEN_ARTIFACT_BRIDGE_SECRET: 'fixture-bridge-secret-value-0001',
    OPEN_ARTIFACT_ENABLED_TYPES: 'slides,docs,sheets',
    OPEN_ARTIFACT_EMBED_ORIGINS: 'https://app.example,https://preview.example',
  }

  assert.deepEqual(applicationEnvironment(bindings), {
    BETTER_AUTH_URL: 'https://app.example',
    MIKKA_API_INGRESS: 'cloudflare',
    OPEN_ARTIFACT_HOST_ORIGIN: 'https://artifacts.example',
    OPEN_ARTIFACT_BRIDGE_SECRET: 'fixture-bridge-secret-value-0001',
    OPEN_ARTIFACT_ENABLED_TYPES: 'slides,docs,sheets',
    OPEN_ARTIFACT_EMBED_ORIGINS: 'https://app.example,https://preview.example',
  })
})

test('applicationEnvironment omits unset, empty, or non-string OPEN_ARTIFACT_* values', () => {
  const emptyEnv = applicationEnvironment({ PUBLIC_ORIGIN: 'https://app.example' })
  for (const name of OPEN_ARTIFACT_VARS) {
    assert.equal(Object.hasOwn(emptyEnv, name), false, `${name} should be omitted when unset`)
  }

  for (const invalidValue of [undefined, null, '', 123, true]) {
    const bindings = Object.fromEntries(OPEN_ARTIFACT_VARS.map(name => [name, invalidValue]))
    const env = applicationEnvironment({ PUBLIC_ORIGIN: 'https://app.example', ...bindings })
    for (const name of OPEN_ARTIFACT_VARS) {
      assert.equal(Object.hasOwn(env, name), false, `${name} should be omitted for ${String(invalidValue)}`)
    }
  }
})

test('applicationEnvironment does not forward Open Artifact host-only secrets to Business API', () => {
  const env = applicationEnvironment({
    PUBLIC_ORIGIN: 'https://app.example',
    OPEN_ARTIFACT_HOST_ORIGIN: 'https://artifacts.example',
    OPEN_ARTIFACT_BRIDGE_SECRET: 'fixture-bridge-secret-value-0001',
    OA_SIGNING_KEYS: 'fixture-signing-key-only-for-host',
    OA_OWNER_KEY: 'fixture-owner-key-only-for-host',
    MIKKA_BRIDGE_SECRET: 'fixture-host-bridge-secret',
  })

  assert.equal(env.OPEN_ARTIFACT_HOST_ORIGIN, 'https://artifacts.example')
  assert.equal(env.OPEN_ARTIFACT_BRIDGE_SECRET, 'fixture-bridge-secret-value-0001')
  for (const hostOnly of ['OA_SIGNING_KEYS', 'OA_OWNER_KEY', 'MIKKA_BRIDGE_SECRET']) {
    assert.equal(Object.hasOwn(env, hostOnly), false, `${hostOnly} must never reach Business API`)
  }
})

test('applicationEnvironment forwards all multi-plan STRIPE_*_RESOURCE_PRICE_ID bindings', () => {
  const env = applicationEnvironment({
    PUBLIC_ORIGIN: 'https://app.example',
    STRIPE_PRO_RESOURCE_PRICE_ID: 'price_pro_live',
    STRIPE_TEAM_RESOURCE_PRICE_ID: 'price_team_live',
    STRIPE_ENTERPRISE_RESOURCE_PRICE_ID: 'price_ent_live',
  })

  assert.equal(env.STRIPE_PRO_RESOURCE_PRICE_ID, 'price_pro_live')
  assert.equal(env.STRIPE_TEAM_RESOURCE_PRICE_ID, 'price_team_live')
  assert.equal(env.STRIPE_ENTERPRISE_RESOURCE_PRICE_ID, 'price_ent_live')
})
