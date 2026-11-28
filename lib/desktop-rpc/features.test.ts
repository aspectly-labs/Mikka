import assert from 'node:assert/strict'
import test from 'node:test'
import { CLIENT_FLAG_KEYS, gatedFeatures, killSwitches, upcomingFeatures } from '@/lib/feature-flags'
import { desktopFeatures } from './features'

test('desktop flags use only the client flag keys and the verified user identity', async () => {
  const calls: [string, string][] = []
  const evaluate = async (key: string, userId: string) => {
    calls.push([key, userId])
    return userId === 'owner' && [gatedFeatures.cloudComputer.key, upcomingFeatures.product.key, killSwitches.computerTab].includes(key)
  }
  const owner = await desktopFeatures('owner', { evaluate, env: {} })
  assert.equal(owner.cloudComputer, true)
  assert.equal(owner.flags[killSwitches.computerTab], true)
  assert.equal(owner.flags[upcomingFeatures.product.key], true)
  assert.equal(owner.flags[gatedFeatures.computerBilling.key], false)
  assert.deepEqual(calls.map(([key]) => key).sort(), [...CLIENT_FLAG_KEYS].sort())
  assert.ok(calls.every(([, userId]) => userId === 'owner'))
  const peer = await desktopFeatures('peer', { evaluate, env: {} })
  assert.equal(peer.cloudComputer, false)
  assert.ok(Object.values(peer.flags).every(value => value === false))
})

test('signed-out config uses public defaults without evaluating an anonymous identity', async () => {
  const features = await desktopFeatures(undefined, { evaluate: async () => { throw new Error('anonymous flag evaluation') }, env: {} })
  assert.equal(features.cloudComputer, false)
  assert.equal(Object.keys(features.flags).length, CLIENT_FLAG_KEYS.length)
  assert.equal(features.flags[gatedFeatures.environmentSnapshots.key], false)
  assert.ok(Object.values(features.flags).every(value => value === false))
})

test('the cloud-computer snapshot keeps the exact existing public environment predicates', async () => {
  for (const [deployment, acceptance, enabled, expected] of [
    ['preview', '1', undefined, true], ['production', undefined, '1', true],
    ['preview', undefined, '1', false], ['production', '1', undefined, false],
    [undefined, '1', '1', false], ['production', undefined, 'true', false],
  ] as const) {
    const features = await desktopFeatures(undefined, { env: { MIKKA_PUBLIC_COMPUTER_DEPLOYMENT: deployment, MIKKA_PUBLIC_COMPUTER_ACCEPTANCE: acceptance, MIKKA_PUBLIC_COMPUTER_ENABLED: enabled, PRIVATE_SECRET: 'never returned' } })
    assert.equal(features.cloudComputer, expected)
    assert.equal(JSON.stringify(features).includes('never returned'), false)
  }
  assert.equal((await desktopFeatures(undefined, { env: { MIKKA_PUBLIC_COMPUTER_MOCK: '1' } })).cloudComputer, true)
})

test('a remote PostHog flag reaches the desktop renderer through postHogFlag, as on the web', async () => {
  const { serverFlagEnabled, clearFlagCache } = await import('@/lib/posthog-server')
  // A stubbed flags answer: PostHog has turned this flag on for this one person.
  const asked: string[] = []
  const posthog = {
    async getFeatureFlag(key: string, distinctId: string) { asked.push(`${key}|${distinctId}`); return key === killSwitches.computerTab && distinctId === 'owner' ? true : undefined },
    capture() {}, async flush() {},
  }
  clearFlagCache()
  const features = await desktopFeatures('owner', { evaluate: (key, userId) => serverFlagEnabled(key, userId, { posthog }), env: {} })
  assert.ok(asked.includes(`${killSwitches.computerTab}|owner`), 'the server asks PostHog with the web\'s distinct id, the user id')
  const previous = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = { mikka: { bundled: {} }, location: { origin: 'mikka://app', pathname: '/mikka' } }
  try {
    const { setClientConfiguration } = await import('@/apps/desktop/src/renderer/client-configuration')
    const { onPostHogFlags, postHogFlag } = await import('@/lib/analytics/posthog')
    assert.equal(postHogFlag(killSwitches.computerTab), undefined, 'not loaded yet: the caller keeps its default')
    let notified = 0
    const stop = onPostHogFlags(() => { notified++ })
    setClientConfiguration({ features })
    assert.equal(postHogFlag(killSwitches.computerTab), true)
    assert.equal(postHogFlag(gatedFeatures.memory.key), false)
    assert.equal(postHogFlag('mikka-not-a-client-flag'), undefined, 'only client flags are sent')
    assert.equal(notified, 1)
    // Signing out drops the snapshot: flags read as not loaded again.
    setClientConfiguration(null)
    assert.equal(postHogFlag(killSwitches.computerTab), undefined)
    stop()
  } finally {
    ;(globalThis as { window?: unknown }).window = previous
    clearFlagCache()
  }
})
