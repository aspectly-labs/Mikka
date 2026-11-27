import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

let allowed = true, opens = 0, calls = 0
let keyProvider: 'openai' | 'anthropic' | 'custom' = 'custom'
let keySpeedModes: Record<string, readonly ('fast' | 'ultrafast')[]> | undefined
let keyDaybreak: import('./model-capabilities').DaybreakAccess | undefined
const credentials: unknown[] = []
const callOpts: unknown[] = []
mock.module(new URL('./db/index.ts', import.meta.url).href, { namedExports: { pool: {} } })
mock.module(new URL('./model-api-keys.ts', import.meta.url).href, { namedExports: {
  openApiKeyForChat: async () => {
    opens++
    if (!allowed) throw Error('apiKeyNotFound')
    return {
      apiKey: 'synthetic-key',
      baseUrl: keyProvider === 'openai' ? 'https://api.openai.com/v1' : 'https://provider.fixture.invalid/v1',
      provider: keyProvider,
      ...(keySpeedModes ? { modelSpeedModes: keySpeedModes } : {}),
      ...(keyDaybreak ? { daybreak: keyDaybreak } : {}),
    }
  },
} })
mock.module(new URL('./model-gateway/litellm-client.ts', import.meta.url).href, { namedExports: {
  createLiteLLMModel: (modelId: string, options: unknown) => {
    credentials.push(options)
    return { specificationVersion: 'v4', provider: 'litellm', modelId, supportedUrls: {},
      doGenerate: async (opts: unknown) => { calls++; callOpts.push(opts); return { content: [] } } }
  },
} })
mock.module(new URL('./tracing/ai.ts', import.meta.url).href, { namedExports: { observedModel: (model: unknown) => model } })

test('API key chat routes through LiteLLM and reopens authorization at every call', async () => {
  const { resolveApiKeyChatModel } = await import('./model-api-key-chat')
  const model = await resolveApiKeyChatModel({ type: 'api_key', ownerId: 'owner', workspaceId: 'workspace',
    keyId: 'key', modelId: 'chosen-model', coordinator: true } as never)
  assert.equal(typeof model, 'object')
  if (typeof model !== 'object' || model.specificationVersion !== 'v4') throw Error('Expected a model')
  await model.doGenerate({ prompt: [] })
  assert.equal(opens, 2)
  assert.equal(calls, 1)
  assert.deepEqual(credentials[1], { user: 'workspace', credential: {
    apiKey: 'synthetic-key', baseUrl: 'https://provider.fixture.invalid/v1', provider: 'openai', modelId: 'chosen-model',
  } })
  allowed = false
  await assert.rejects(async () => model.doGenerate({ prompt: [] }), /apiKeyNotFound/)
  assert.equal(calls, 1, 'revoked access cannot dispatch another model request')

  // Verified server-advertised speedModes are forwarded on API-key chats; unadvertised models remain unchanged.
  allowed = true
  keySpeedModes = { 'chosen-model': ['fast', 'ultrafast'] }
  const ultraModel = await resolveApiKeyChatModel({ type: 'api_key', ownerId: 'owner', workspaceId: 'workspace',
    keyId: 'key', modelId: 'chosen-model', coordinator: true } as never, 'ultrafast')
  if (typeof ultraModel !== 'object' || ultraModel.specificationVersion !== 'v4') throw Error('Expected a model')
  await ultraModel.doGenerate({ prompt: [] })
  assert.deepEqual((callOpts.at(-1) as { providerOptions?: Record<string, unknown> }).providerOptions, {
    openai: { serviceTier: 'ultrafast' },
    openaiCompatible: { service_tier: 'ultrafast' },
  })
  keySpeedModes = { 'chosen-model': [] }
  await ultraModel.doGenerate({ prompt: [] })
  assert.equal((callOpts.at(-1) as { providerOptions?: unknown }).providerOptions, undefined)

  // OpenAI BYOK Daybreak re-verifies provider and live Daybreak entitlement on every call.
  keyProvider = 'custom'
  keyDaybreak = { checkedAt: '2026-11-26T00:00:00.000Z', granted: ['chosen-model'], tiers: ['red'], grants: [{ tier: 'red', granted: ['chosen-model'] }] }
  await assert.rejects(async () => resolveApiKeyChatModel({ type: 'api_key', ownerId: 'owner', workspaceId: 'workspace',
    keyId: 'key', modelId: 'chosen-model', coordinator: true } as never, undefined, false, 'daybreak_red'), /model_daybreak_unavailable/)
  keyProvider = 'openai'
  const daybreakModel = await resolveApiKeyChatModel({ type: 'api_key', ownerId: 'owner', workspaceId: 'workspace',
    keyId: 'key', modelId: 'chosen-model', coordinator: true } as never, undefined, false, 'daybreak_red')
  if (typeof daybreakModel !== 'object' || daybreakModel.specificationVersion !== 'v4') throw Error('Expected a model')
  await daybreakModel.doGenerate({ prompt: [] })
  assert.equal((credentials.at(-1) as { cyberAccessProgram?: string }).cyberAccessProgram, 'daybreak_red')
  keyDaybreak = { checkedAt: '2026-11-26T00:00:00.000Z', granted: [] }
  await assert.rejects(async () => daybreakModel.doGenerate({ prompt: [] }), /model_daybreak_unavailable/)
})
