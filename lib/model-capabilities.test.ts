import assert from 'node:assert/strict'
import { test } from 'node:test'
import { effortFor, resolveModelCapabilities, speedFor } from './model-capabilities'

test('a provider-listed catalogue decides the levels, lowest first, and keeps levels a run cannot carry apart', () => {
  const codex = resolveModelCapabilities({ modelId: 'gpt-6.1-sol', provider: 'codex',
    advertisedEfforts: ['max', 'low', 'medium', 'high', 'xhigh', 'ultra'], advertisedDefault: 'low', speedModes: ['fast'] })
  assert.deepEqual(codex.efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(codex.defaultEffort, 'low')
  assert.equal(codex.effortSource, 'provider')
  assert.deepEqual(codex.providerOnly, ['ultra'])
  assert.deepEqual(codex.speedModes, ['fast'])
  // gpt-5.5 lists four levels: the picker shows four, not Mikka's five.
  assert.deepEqual(resolveModelCapabilities({ modelId: 'gpt-5.5', provider: 'codex', advertisedEfforts: ['low', 'medium', 'high', 'xhigh'] }).efforts,
    ['low', 'medium', 'high', 'xhigh'])
})

test('a model the provider describes with no levels takes none, even when Mikka\'s list knows it', () => {
  const none = resolveModelCapabilities({ modelId: 'claude-sonnet-5-5', provider: 'claude', advertisedEfforts: [] })
  assert.deepEqual(none.efforts, [])
  assert.equal(none.effortSource, 'provider')
  // A Gateway model with no reasoning options: no level control.
  assert.deepEqual(resolveModelCapabilities({ modelId: 'meta/llama-4-maverick', advertisedEfforts: [] }).efforts, [])
})

test('without a provider catalogue the built-in list answers, by the CLI\'s own model name', () => {
  const claude = resolveModelCapabilities({ modelId: 'anthropic/claude-opus-5.5' })
  assert.equal(claude.effortSource, 'builtin')
  assert.deepEqual(claude.efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(resolveModelCapabilities({ modelId: 'gpt-5.5', provider: 'codex' }).efforts, ['low', 'medium', 'high', 'xhigh'])
  const unknown = resolveModelCapabilities({ modelId: 'deepseek/deepseek-v4-pro' })
  assert.deepEqual(unknown.efforts, [])
  assert.equal(unknown.effortSource, 'none')
})

test('a saved level or speed applies only when the model supports it', () => {
  const caps = resolveModelCapabilities({ modelId: 'gpt-5.5', advertisedEfforts: ['low', 'medium'], speedModes: ['fast'] })
  assert.equal(effortFor(caps, 'medium'), 'medium')
  assert.equal(effortFor(caps, 'max'), null)
  assert.equal(speedFor(caps, 'fast'), 'fast')
  assert.equal(speedFor(caps, 'ultrafast'), null)
})

test('route grouping normalizes provider ids and keeps custom endpoints under their own label', async () => {
  const { modelKeyOf } = await import('./model-capabilities')
  const { groupModelOptions, orderedRouteGroups } = await import('./bot-model-menu-view')
  assert.notEqual(modelKeyOf('team-a/chat', 'custom', 'Proxy'), modelKeyOf('team-b/chat', 'custom', 'Proxy'))
  assert.notEqual(modelKeyOf('vendor/team-a/chat', 'mikka'), modelKeyOf('vendor/team-b/chat', 'mikka'))
  const key = modelKeyOf('anthropic/claude-opus-4.6', 'mikka')
  assert.equal(modelKeyOf('claude-opus-4-6', 'claude'), key)
  assert.equal(modelKeyOf('anthropic/claude-opus-4.6', 'custom', 'Team inference'), 'team inference/anthropic/claude-opus-4.6')
  const groups = (['hosted', 'shared', 'apiKey', 'subscription'] as const).map(kind => ({
    kind, options: [{ id: kind, modelId: 'claude-opus-4-6', modelKey: key, provider: 'anthropic' }],
  }))
  assert.deepEqual(orderedRouteGroups(groups).map(group => group.kind), ['subscription', 'apiKey', 'shared', 'hosted'])
  const [model] = groupModelOptions(groups)
  assert.deepEqual([model.key, model.name, model.routes.map(route => route.id)], [key, 'Opus 4.6', ['subscription', 'apiKey', 'shared', 'hosted']])
})

test('only advertised modes are selectable; Daybreak combines with speed/Pro only when granted', async () => {
  const { NO_MODES, cyberAccessProgram, daybreakTierFor, daybreakTierFromProgram, modesFor, parseDaybreakAccess, supportedModes } = await import('./model-capabilities')
  const withDaybreak = resolveModelCapabilities({ modelId: 'gpt-6.1-sol', speedModes: ['fast'], pro: true, daybreak: 'blue' })
  assert.equal(supportedModes(withDaybreak, { ...NO_MODES, fast: true }), true)
  assert.equal(supportedModes(withDaybreak, { ...NO_MODES, daybreak: true }), true)
  assert.equal(supportedModes(withDaybreak, { ...NO_MODES, fast: true, daybreak: true }), true)
  assert.equal(supportedModes(withDaybreak, { ...NO_MODES, pro: true, daybreak: true }), true)
  for (const request of [{ ultrafast: true }, { pro: true, fast: true }, { pro: true, fast: true, daybreak: true }]) {
    assert.equal(supportedModes(withDaybreak, { ...NO_MODES, ...request }), false)
  }
  assert.deepEqual(modesFor(withDaybreak, { ...NO_MODES, fast: true, daybreak: true }), { fast: true, ultrafast: false, pro: false, daybreak: true })

  const withoutDaybreak = resolveModelCapabilities({ modelId: 'gpt-6.1-sol', speedModes: ['fast'] })
  assert.equal(supportedModes(withoutDaybreak, { ...NO_MODES, daybreak: true }), false)
  assert.deepEqual(modesFor(withoutDaybreak, { ...NO_MODES, fast: true, daybreak: true }), { fast: true, ultrafast: false, pro: false, daybreak: false })

  assert.equal(cyberAccessProgram('blue'), 'daybreak_blue')
  assert.equal(cyberAccessProgram('red'), 'daybreak_red')
  assert.equal(daybreakTierFromProgram('daybreak_blue'), 'blue')
  assert.equal(daybreakTierFromProgram('daybreak_red'), 'red')
  assert.equal(daybreakTierFromProgram('other'), undefined)

  const parsed = parseDaybreakAccess({
    checkedAt: '2026-11-26T00:00:00.000Z',
    granted: ['gpt-6-cyber', 'gpt-6.1-sol'],
    tiers: ['blue', 'red'],
    grants: [
      { tier: 'blue', granted: ['gpt-6.1-sol'] },
      { tier: 'red', granted: ['gpt-6-cyber'] },
    ],
  })
  assert.deepEqual(parsed, {
    checkedAt: '2026-11-26T00:00:00.000Z',
    granted: ['gpt-6-cyber', 'gpt-6.1-sol'],
    tiers: ['blue', 'red'],
    grants: [
      { tier: 'blue', granted: ['gpt-6.1-sol'] },
      { tier: 'red', granted: ['gpt-6-cyber'] },
    ],
  })
  assert.equal(parseDaybreakAccess({ granted: ['gpt-6-cyber'], tiers: ['green'] }), undefined)
  assert.equal(daybreakTierFor(parsed, 'gpt-6-cyber'), 'red')
  assert.equal(daybreakTierFor(parsed, 'gpt-6.1-sol'), 'blue')
  assert.equal(daybreakTierFor(parsed, 'gpt-5'), undefined)
})
