import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearFlagCache, FLAG_CACHE_MS, serverFlagEnabled, serverTaskProviderVariant, type ServerPostHog } from './posthog-server'

function fake(answer: () => Promise<boolean | string | undefined>) {
  const captured: { distinctId: string; event: string; properties?: Record<string, unknown> }[] = []
  let checks = 0
  const posthog: ServerPostHog = {
    getFeatureFlag: async () => { checks++; return answer() },
    capture: message => { captured.push(message) },
    flush: async () => {},
  }
  return { posthog, captured, checks: () => checks }
}

test('a person flag is on only when PostHog answers exactly true', async () => {
  for (const [value, expected] of [[true, true], [false, false], ['true', false], ['control', false], [undefined, false]] as const) {
    clearFlagCache()
    assert.equal(await serverFlagEnabled('mikka-proactive-profile', 'u1', { posthog: fake(async () => value).posthog }), expected, String(value))
  }
})

test('an unavailable PostHog reads off: no client, an error or a timeout', async t => {
  t.mock.method(console, 'error', () => {})
  clearFlagCache()
  assert.equal(await serverFlagEnabled('mikka-proactive-profile', 'u1', { posthog: null }), false)
  clearFlagCache()
  assert.equal(await serverFlagEnabled('mikka-proactive-profile', 'u1', { posthog: fake(async () => { throw new Error('network down') }).posthog }), false)
  clearFlagCache()
  assert.equal(await serverFlagEnabled('mikka-proactive-profile', 'u1', { posthog: fake(() => new Promise(() => {})).posthog, timeoutMs: 10 }), false)
})

test('without a project, deployed subscription routes work and billing or experiments stay off', async () => {
  clearFlagCache()
  for (const key of ['mikka-byos-subscription-chat', 'mikka-byos-subscription-native', 'mikka-cloud-computer']) {
    assert.equal(await serverFlagEnabled(key, 'community-user', { posthog: null }), true, key)
  }
  for (const key of ['mikka-computer-billing', 'mikka-email-sign-in-off', 'mikka-computer-tab-off', 'mikka-proactive-research', 'mikka-upcoming-administration']) {
    assert.equal(await serverFlagEnabled(key, 'community-user', { posthog: null }), false, key)
  }
})

test('a flag value is reused for a few minutes per person and key', async () => {
  clearFlagCache()
  const client = fake(async () => true)
  const now = 1_000_000
  assert.equal(await serverFlagEnabled('k', 'u1', { posthog: client.posthog, now }), true)
  assert.equal(await serverFlagEnabled('k', 'u1', { posthog: client.posthog, now: now + 1000 }), true)
  assert.equal(client.checks(), 1)
  await serverFlagEnabled('k', 'u2', { posthog: client.posthog, now })
  await serverFlagEnabled('other', 'u1', { posthog: client.posthog, now })
  assert.equal(client.checks(), 3)
  await serverFlagEnabled('k', 'u1', { posthog: client.posthog, now: now + FLAG_CACHE_MS })
  assert.equal(client.checks(), 4)
})

test('local overrides exercise on and off without inheriting cached remote values', async () => {
  const previous = { node: process.env.NODE_ENV, flags: process.env.MIKKA_FLAG_OVERRIDES }
  try {
    process.env.NODE_ENV = 'test'
    clearFlagCache()
    const client = fake(async () => true)
    assert.equal(await serverFlagEnabled('local-example', 'u1', { posthog: client.posthog }), true)
    process.env.MIKKA_FLAG_OVERRIDES = '{"local-example":false}'
    assert.equal(await serverFlagEnabled('local-example', 'u1', { posthog: client.posthog }), false)
    process.env.MIKKA_FLAG_OVERRIDES = '{"local-example":true}'
    assert.equal(await serverFlagEnabled('local-example', 'u1', { posthog: null }), true)
    assert.equal(client.checks(), 1)
    process.env.MIKKA_FLAG_OVERRIDES = '{"local-example":"false"}'
    await assert.rejects(serverFlagEnabled('local-example', 'u1', { posthog: null }), /REQUIRE_BOOLEANS/)
    process.env.MIKKA_FLAG_OVERRIDES = 'not-json'
    await assert.rejects(serverFlagEnabled('local-example', 'u1', { posthog: null }), /INVALID_JSON/)
  } finally {
    if (previous.node === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous.node
    if (previous.flags === undefined) delete process.env.MIKKA_FLAG_OVERRIDES
    else process.env.MIKKA_FLAG_OVERRIDES = previous.flags
    clearFlagCache()
  }
})

test('production and unclassified runtimes ignore local overrides, including malformed JSON', async () => {
  const previous = { node: process.env.NODE_ENV, flags: process.env.MIKKA_FLAG_OVERRIDES }
  try {
    for (const runtime of ['production', 'preview', undefined]) {
      if (runtime === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = runtime
      for (const flags of ['{"mikka-cloud-computer":false,"mikka-computer-billing":true}', 'not-json']) {
        process.env.MIKKA_FLAG_OVERRIDES = flags
        clearFlagCache()
        assert.equal(await serverFlagEnabled('mikka-cloud-computer', 'u1', { posthog: null }), true)
        assert.equal(await serverFlagEnabled('mikka-computer-billing', 'u1', { posthog: null }), false)
      }
    }
  } finally {
    if (previous.node === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous.node
    if (previous.flags === undefined) delete process.env.MIKKA_FLAG_OVERRIDES
    else process.env.MIKKA_FLAG_OVERRIDES = previous.flags
    clearFlagCache()
  }
})

test('task provider targets the authenticated person and workspace, with no stale run-to-run cache', async () => {
  const contexts: unknown[] = []
  let variant: string | boolean = 'cloudflare'
  const posthog: ServerPostHog = {
    getFeatureFlag: async (key, user, options) => { contexts.push([key, user, options]); return variant },
    capture() {},
    async flush() {},
  }
  assert.equal(await serverTaskProviderVariant('u1', 'w1', { posthog }), 'cloudflare')
  variant = 'e2b'
  assert.equal(await serverTaskProviderVariant('u1', 'w1', { posthog }), 'e2b')
  variant = true
  assert.equal(await serverTaskProviderVariant('u2', 'w2', { posthog }), undefined)
  assert.equal(await serverTaskProviderVariant('u1', 'w1', { posthog: null }), undefined)
  assert.deepEqual(contexts, [
    ['mikka-task-provider', 'u1', { groups: { workspace: 'w1' }, personProperties: { workspace_id: 'w1' }, sendFeatureFlagEvents: false }],
    ['mikka-task-provider', 'u1', { groups: { workspace: 'w1' }, personProperties: { workspace_id: 'w1' }, sendFeatureFlagEvents: false }],
    ['mikka-task-provider', 'u2', { groups: { workspace: 'w2' }, personProperties: { workspace_id: 'w2' }, sendFeatureFlagEvents: false }],
  ])
})

test('task placement defaults preserve the legacy workspace and explicit Cloudflare choices', async () => {
  const {
    DEFAULT_CLOUD_TASK_MACHINE_PLAN_LIMITS,
    configuredTaskMachinePlanLimits,
    selectTaskProvider,
    taskComputeSku,
  } = await import('./cloud-computer/task-provider-admission')
  const previous = { node: process.env.NODE_ENV, flags: process.env.MIKKA_FLAG_OVERRIDES, workspaces: process.env.MIKKA_CLOUDFLARE_TASK_WORKSPACES }
  try {
    process.env.NODE_ENV = 'test'
    delete process.env.MIKKA_FLAG_OVERRIDES
    process.env.MIKKA_CLOUDFLARE_TASK_WORKSPACES = 'workspace-a, workspace-b'
    const listed = { userId: 'person', workspaceId: 'workspace-b' }
    const outside = { userId: 'person', workspaceId: 'workspace' }
    assert.deepEqual(await selectTaskProvider(listed, false), { provider: 'cloudflare', source: 'legacy_workspace' })
    assert.deepEqual(await selectTaskProvider(outside, true), { provider: 'cloudflare', source: 'legacy_explicit' })
    assert.deepEqual(await selectTaskProvider(outside, false), { provider: 'e2b', source: 'default' })
    process.env.MIKKA_FLAG_OVERRIDES = '{"mikka-task-provider":"e2b"}'
    assert.deepEqual(await selectTaskProvider(listed, true), { provider: 'e2b', source: 'remote' })
    process.env.MIKKA_FLAG_OVERRIDES = '{"mikka-task-provider":"cloudflare"}'
    assert.deepEqual(await selectTaskProvider(outside, false), { provider: 'cloudflare', source: 'remote' })
    assert.deepEqual(taskComputeSku('e2b', { cloudflare: 'standard-3' }, false), { provider: 'e2b', size: 'medium' })
    assert.deepEqual(taskComputeSku('cloudflare', { e2b: 'large' }, false), { provider: 'cloudflare', size: 'standard-4' })

    // #3330: Mikka Cloud defaults block Free and align Pro ($20) with Capy's 4 vCPU / 16 GiB ceiling.
    assert.deepEqual(DEFAULT_CLOUD_TASK_MACHINE_PLAN_LIMITS, {
      free: null,
      pro: { vcpu: 4, ramGib: 16 },
      enterprise: { vcpu: 8, ramGib: 32 },
    })
    assert.equal(configuredTaskMachinePlanLimits({ MIKKA_EDITION: 'community' }), null)
    assert.deepEqual(configuredTaskMachinePlanLimits({ MIKKA_EDITION: 'cloud' }), DEFAULT_CLOUD_TASK_MACHINE_PLAN_LIMITS)
    assert.deepEqual(
      configuredTaskMachinePlanLimits({
        MIKKA_EDITION: 'cloud',
        MIKKA_TASK_MACHINE_PLAN_LIMITS: JSON.stringify({ pro: { vcpu: 2, ramGib: 8 } }),
      }),
      { free: null, pro: { vcpu: 2, ramGib: 8 }, enterprise: { vcpu: 8, ramGib: 32 } },
    )
    assert.deepEqual(
      configuredTaskMachinePlanLimits({
        MIKKA_EDITION: 'cloud',
        MIKKA_TASK_MACHINE_PLAN_LIMITS: JSON.stringify({ enterprise: { vcpu: 16, ramGib: 64 } }),
      }),
      { free: null, pro: { vcpu: 4, ramGib: 16 }, enterprise: { vcpu: 16, ramGib: 64 } },
    )
    assert.deepEqual(
      configuredTaskMachinePlanLimits({
        MIKKA_EDITION: 'community',
        MIKKA_TASK_MACHINE_PLAN_LIMITS: JSON.stringify({ pro: { vcpu: 2, ramGib: 8 } }),
      }),
      { pro: { vcpu: 2, ramGib: 8 } },
    )
    assert.equal(taskComputeSku('e2b', { e2b: 'small' }, false, DEFAULT_CLOUD_TASK_MACHINE_PLAN_LIMITS.free), null)
    assert.equal(taskComputeSku('cloudflare', { cloudflare: 'standard-1' }, false, DEFAULT_CLOUD_TASK_MACHINE_PLAN_LIMITS.free), null)
    assert.deepEqual(taskComputeSku('e2b', { e2b: 'large' }, false, DEFAULT_CLOUD_TASK_MACHINE_PLAN_LIMITS.pro), { provider: 'e2b', size: 'large' })
    assert.deepEqual(taskComputeSku('e2b', { e2b: 'ultra' }, false, DEFAULT_CLOUD_TASK_MACHINE_PLAN_LIMITS.pro), { provider: 'e2b', size: 'large' })
    assert.deepEqual(taskComputeSku('e2b', { e2b: 'ultra' }, false, DEFAULT_CLOUD_TASK_MACHINE_PLAN_LIMITS.enterprise), { provider: 'e2b', size: 'ultra' })
    assert.deepEqual(taskComputeSku('cloudflare', { cloudflare: 'standard-4-16' }, true, DEFAULT_CLOUD_TASK_MACHINE_PLAN_LIMITS.pro), { provider: 'cloudflare', size: 'standard-4-16' })
    assert.deepEqual(taskComputeSku('cloudflare', { cloudflare: 'standard-4-16' }, false, DEFAULT_CLOUD_TASK_MACHINE_PLAN_LIMITS.pro), { provider: 'cloudflare', size: 'standard-4' })
  } finally {
    for (const [key, value] of [['NODE_ENV', previous.node], ['MIKKA_FLAG_OVERRIDES', previous.flags], ['MIKKA_CLOUDFLARE_TASK_WORKSPACES', previous.workspaces]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
