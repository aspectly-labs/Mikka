import assert from 'node:assert/strict'
import test from 'node:test'
import { modelOrderSeedAction, preferredModel, seedModelKeys, type SeedDeps, type SeedState } from './seed-model-keys'

function fake(owners: string[]) {
  const keys = new Map<string, { id: string; models: string[] }>()
  const pending = new Map(owners.map(owner => [owner, ['bot-1', null] as (string | null)[]]))
  const choices: string[] = []
  const preferences: string[] = []
  let additions = 0
  const deps: SeedDeps = {
    owners: async () => owners.map(ownerId => ({ ownerId, key: keys.get(ownerId) })),
    addKey: async owner => { additions++; const key = { id: `key-${owner}`, models: ['deepseek-chat', 'deepseek-v4.1-flash', 'deepseek-v4-pro'] }; keys.set(owner, key); return key },
    // Membership scopes exist even when every Bot choice is already current:
    // coding-run dispatch has its own model-order preference to seed.
    scopes: async owner => [{ workspaceId: 'ws-1', botIds: [...pending.get(owner) ?? []] }],
    prefer: async (scope, keyId, model) => { preferences.push(`${scope.ownerId}/${scope.workspaceId}=${keyId}:${model}`) },
    choose: async (scope, botId, keyId, model) => {
      choices.push(`${scope.ownerId}/${botId ?? 'coordinator'}=${keyId}:${model}`)
      pending.set(scope.ownerId, pending.get(scope.ownerId)!.filter(id => id !== botId))
    },
  }
  return { deps, choices, preferences, pending, additions: () => additions }
}

test('seeds each account once and covers bots created after the key', async () => {
  const { deps, choices, pending, additions } = fake(['u1', 'u2'])
  assert.equal(await seedModelKeys('sk-test', deps), 2)
  assert.equal(await seedModelKeys('sk-test', deps), 0)
  assert.equal(choices.length, 4)
  pending.set('u1', ['later-bot'])
  await seedModelKeys('sk-test', deps)
  assert.equal(choices.at(-1), 'u1/later-bot=key-u1:deepseek-v4.1-flash')
  assert.equal(additions(), 2)
})

test('seeds dispatch preference even when every bot choice is already current', async () => {
  const { deps, preferences } = fake(['u1'])
  assert.equal(await seedModelKeys('sk-test', deps), 1)
  assert.deepEqual(preferences, ['u1/ws-1=key-u1:deepseek-v4.1-flash'])
  assert.equal(await seedModelKeys('sk-test', deps), 0)
  assert.deepEqual(preferences, ['u1/ws-1=key-u1:deepseek-v4.1-flash', 'u1/ws-1=key-u1:deepseek-v4.1-flash'],
    'the model-order writer is still consulted after bot_model_choices converges')
})

test('model-order seeding uses production writer changes for position zero', () => {
  const flash = { harness: 'claude_code' as const, model: 'deepseek-v4.1-flash', source: { kind: 'api_key' as const, keyId: 'key-1' } }
  assert.deepEqual(modelOrderSeedAction({ preferredHarness: 'claude_code', entries: [
    { id: 'default-1', harness: 'claude_code', model: 'mikka-default', source: { kind: 'api_key', keyId: 'key-1' } },
  ] }, 'key-1', 'deepseek-v4.1-flash'), { kind: 'add', entries: [flash], at: 0 })

  assert.deepEqual(modelOrderSeedAction({ preferredHarness: 'codex', entries: [
    { id: 'codex-default', harness: 'codex', model: 'mikka-default', source: { kind: 'api_key', keyId: 'key-1' } },
    { id: 'claude-default', harness: 'claude_code', model: 'mikka-default', source: { kind: 'api_key', keyId: 'key-1' } },
  ] }, 'key-1', 'deepseek-v4.1-flash'), { kind: 'add', entries: [{ ...flash, harness: 'codex' }], at: 0 })

  assert.deepEqual(modelOrderSeedAction({ preferredHarness: 'claude_code', entries: [
    { id: 'codex-default', harness: 'codex', model: 'mikka-default', source: { kind: 'api_key', keyId: 'key-1' } },
    { id: 'claude-default', harness: 'claude_code', model: 'mikka-default', source: { kind: 'api_key', keyId: 'key-1' } },
    { id: 'flash-existing', harness: 'claude_code', model: 'deepseek-v4.1-flash', source: { kind: 'api_key', keyId: 'key-1' } },
  ] }, 'key-1', 'deepseek-v4.1-flash'), { kind: 'reorder', ids: ['flash-existing', 'codex-default', 'claude-default'] })

  assert.equal(modelOrderSeedAction({ preferredHarness: 'claude_code', entries: [
    { id: 'flash-existing', harness: 'claude_code', model: 'deepseek-v4.1-flash', source: { kind: 'api_key', keyId: 'key-1' } },
    { id: 'claude-default', harness: 'claude_code', model: 'mikka-default', source: { kind: 'api_key', keyId: 'key-1' } },
  ] }, 'key-1', 'deepseek-v4.1-flash'), null)
})

test('one provider failure does not block later owners and backs off', async () => {
  const { deps, choices, additions } = fake(['bad', 'good'])
  const add = deps.addKey
  let attempts = 0
  deps.addKey = async (owner, key) => { if (owner === 'bad') { attempts++; throw new Error(`Authorization: ${key}`) }; return add(owner, key) }
  const state: SeedState = new Map()
  const messages: string[] = []
  await seedModelKeys('secret-test', deps, line => messages.push(line), state, () => 0)
  await seedModelKeys('secret-test', deps, line => messages.push(line), state, () => 5000)
  assert.equal(attempts, 1)
  assert.equal(additions(), 1)
  assert.equal(choices.length, 2)
  assert.ok(messages.every(line => !line.includes('secret-test')))
  await seedModelKeys('secret-test', deps, () => {}, state, () => 30_000)
  assert.equal(attempts, 2)
  assert.equal(state.get('bad')?.retryAt, 90_000)
})

test('a model choice failure reuses the stored key on retry', async () => {
  const { deps, additions } = fake(['u1'])
  const choose = deps.choose
  let failed = false
  deps.choose = async (...args) => { if (!failed) { failed = true; throw new Error('temporary') }; await choose(...args) }
  const state: SeedState = new Map()
  await seedModelKeys('test', deps, () => {}, state, () => 0)
  await seedModelKeys('test', deps, () => {}, state, () => 30_000)
  assert.equal(additions(), 1)
  assert.equal(state.size, 0)
})

test('without a key nothing is seeded; local acceptance never falls back to chat', async () => {
  const { deps, choices } = fake(['u1'])
  assert.equal(await seedModelKeys(undefined, deps), 0)
  assert.deepEqual(choices, [])
  assert.equal(preferredModel(['a', 'deepseek-flash']), 'deepseek-flash')
  assert.equal(preferredModel(['deepseek-chat']), undefined)
  assert.equal(preferredModel(['deepseek-v4-pro']), undefined)
  assert.equal(preferredModel(['deepseek-v4-pro-flash']), undefined)
  assert.equal(preferredModel(['deepseek-v4-pro', 'deepseek-flash']), 'deepseek-flash')
  assert.equal(preferredModel([]), undefined)
})

test('the loop refuses to run outside dev:local', async () => {
  const { assertDevLocal } = await import('./guard.mjs')
  assert.throws(() => assertDevLocal({ MIKKA_LOCAL_TEST_ACCOUNTS: '1' }), /dev:local needs/)
  assert.throws(() => assertDevLocal({ MIKKA_LOCAL_TEST_ACCOUNTS: '1', E2E_DATABASE_URL: 'postgres://a:b@127.0.0.1/x_e2e', VERCEL_ENV: 'preview' }), /dev:local needs/)
})
