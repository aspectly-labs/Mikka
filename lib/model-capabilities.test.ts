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

test('only an advertised single mode is selectable and entitlement labels are read-only', async () => {
  const { NO_MODES, supportedModes } = await import('./model-capabilities')
  const caps = resolveModelCapabilities({ modelId: 'fixture', speedModes: ['fast'], daybreak: 'blue' })
  assert.equal(supportedModes(caps, { ...NO_MODES, fast: true }), true)
  for (const request of [{ ultrafast: true }, { pro: true }, { daybreak: true }, { pro: true, fast: true }]) {
    assert.equal(supportedModes(caps, { ...NO_MODES, ...request }), false)
  }
})
