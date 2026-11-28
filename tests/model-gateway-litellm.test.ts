import assert from 'node:assert/strict'
import { converterCompatibilityRequest } from '../cloudflare/litellm/request.mjs'
import test from 'node:test'
import { handleModelGateway, type GatewayDependencies } from '../lib/model-gateway/handler'
import type { GatewayGrant } from '../lib/model-gateway/token'

/*
 * Decision 2026-11-15-2000, against a real LiteLLM started with
 * deploy/litellm/config.yaml and an OpenAI-compatible Chat Completions server:
 *   MIKKA_LITELLM_TEST_URL=http://127.0.0.1:4012 MIKKA_LITELLM_TEST_MASTER_KEY=… \
 *   MIKKA_LITELLM_TEST_PROVIDER=http://127.0.0.1:9911/v1
 * The gateway sends Claude Code's Anthropic messages and Codex's Responses
 * requests through LiteLLM to a provider that speaks only Chat Completions,
 * with the person's key on that one request, and settles from the converted usage.
 */
const url = process.env.MIKKA_LITELLM_TEST_URL, masterKey = process.env.MIKKA_LITELLM_TEST_MASTER_KEY, provider = process.env.MIKKA_LITELLM_TEST_PROVIDER
const skip = !url || !masterKey || !provider

function dependencies(grant: GatewayGrant, settled: (number | null)[], credits = false): GatewayDependencies {
  return {
    fetch, verify: async token => token === 'mkg_litellm' ? grant : null,
    upstream: async () => ({ upstream: { url: url!, masterKey: masterKey!, ...(credits ? {} : { credential: { provider: 'openai' as const, apiBase: provider!, key: 'sk-person-key', chatCompletionsOnly: true } }) } }),
    reserve: async () => {}, settle: async (_id, cost) => { settled.push(cost) },
    catalogue: async () => [{ id: grant.model, vendor: 'zai', name: 'GLM', contextWindow: null, maxTokens: null, pricing: { input: 1, output: 2 }, tags: [], reasoning: [] }],
  }
}

test('Claude Code reaches a Chat Completions–only provider through LiteLLM, tool calls included', { skip }, async () => {
  const settled: (number | null)[] = []
  const grant: GatewayGrant = { runId: '10000000-0000-4000-8000-000000000001', ownerId: 'alice', workspaceId: '10000000-0000-4000-8000-000000000002', harness: 'claude_code', model: 'zai/glm-5', source: { kind: 'credits' } }
  const response = await handleModelGateway(new Request('https://mikka.test/api/model-gateway/anthropic/v1/messages', { method: 'POST',
    headers: { 'x-api-key': 'mkg_litellm', 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'use tool' }],
      tools: [{ name: 'bash', description: 'run', input_schema: { type: 'object', properties: { c: { type: 'string' } } } }] }) }), 'anthropic', 'messages', dependencies(grant, settled))
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.match(text, /"type": ?"tool_use"/)
  assert.match(text, /"stop_reason": ?"tool_use"/)
  assert.deepEqual(settled, [20 * 1 + 5 * 2], 'settled from the usage LiteLLM converted')
})

test('Codex reaches a Chat Completions–only provider through LiteLLM', { skip }, async () => {
  const settled: (number | null)[] = []
  const grant: GatewayGrant = { runId: '10000000-0000-4000-8000-000000000001', ownerId: 'alice', workspaceId: '10000000-0000-4000-8000-000000000002', harness: 'codex', model: 'zai/glm-5', source: { kind: 'credits' } }
  const response = await handleModelGateway(new Request('https://mikka.test/api/model-gateway/openai/v1/responses', { method: 'POST',
    headers: { authorization: 'Bearer mkg_litellm', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.5', stream: true, input: 'hi' }) }), 'openai', 'responses', dependencies(grant, settled))
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.match(text, /response\.completed/)
  assert.deepEqual(settled, [11 * 1 + 2 * 2])
})

for (const protocol of ['anthropic', 'openai'] as const) {
  test(`Mikka credits preserve vendor/model through the LiteLLM Vercel wildcard and ${protocol} bridge`, { skip }, async () => {
    const settled: (number | null)[] = []
    const grant: GatewayGrant = { runId: '10000000-0000-4000-8000-000000000001', ownerId: 'alice', workspaceId: '10000000-0000-4000-8000-000000000002',
      harness: protocol === 'anthropic' ? 'claude_code' : 'codex', model: 'fixture/provider-model', source: { kind: 'credits' } }
    const body = protocol === 'anthropic'
      ? { max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hi' }] }
      : { stream: true, input: 'hi' }
    const response = await handleModelGateway(new Request('https://mikka.test/api/model-gateway', { method: 'POST',
      headers: { authorization: 'Bearer mkg_litellm', 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      protocol, protocol === 'anthropic' ? 'messages' : 'responses', dependencies(grant, settled, true))
    assert.equal(response.status, 200)
    assert.match(await response.text(), protocol === 'anthropic' ? /message_delta/ : /response\.completed/)
    assert.deepEqual(settled, [11 * 1 + 2 * 2])
  })
}

for (const model of ['mikka-title', 'neon/gpt-5-mini']) {
  test(`LiteLLM requests ${model} with that upstream's credential`, { skip }, async () => {
    const response = await fetch(url + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + masterKey, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.choices[0].message.content, 'Hello.')
    assert.equal(result.usage.prompt_tokens, 11)
    assert.ok(response.headers.get('x-litellm-call-id'))
  })
}

test('the serving API keeps BYOK working while the shared converter is upgraded', { skip }, async () => {
  const request = new Request(url + '/v1/messages', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + masterKey, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'zai/glm-5', api_base: provider, api_key: 'sk-person-key', max_tokens: 50,
      stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const response = await fetch(await converterCompatibilityRequest(request))
  assert.equal(response.status, 200)
  assert.match(await response.text(), /message_delta/)
})

function setLiteLLMEnvironment(t: import('node:test').TestContext) {
  const previousUrl = process.env.MIKKA_LITELLM_URL, previousKey = process.env.MIKKA_LITELLM_MASTER_KEY
  process.env.MIKKA_LITELLM_URL = url
  process.env.MIKKA_LITELLM_MASTER_KEY = masterKey
  t.after(() => {
    if (previousUrl === undefined) delete process.env.MIKKA_LITELLM_URL
    else process.env.MIKKA_LITELLM_URL = previousUrl
    if (previousKey === undefined) delete process.env.MIKKA_LITELLM_MASTER_KEY
    else process.env.MIKKA_LITELLM_MASTER_KEY = previousKey
  })
}

for (const byok of [true, false]) test(`LiteLLM keeps ${byok ? 'BYOK' : 'Managed'} Responses search, citations and usage intact`, { skip }, async t => {
  setLiteLLMEnvironment(t)
  const { createLiteLLMModel, liteLLMCost, liteLLMGenerationId } = await import('../lib/model-gateway/litellm-client')
  const modelId = byok ? 'gpt-5.5' : 'openai/gpt-6-luna'
  const model = createLiteLLMModel(modelId, byok ? {
    credential: { modelId, provider: 'openai', apiKey: 'sk-person-search-fixture', baseUrl: provider!, nativeResponses: true },
  } : {})
  const result = await model.doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
    tools: [
      { type: 'provider', id: 'openai.web_search', name: 'web_search', args: {} },
      { type: 'function', name: 'lookup', inputSchema: { type: 'object', properties: {} } },
    ],
  })
  const parts = await Array.fromAsync(result.stream)
  assert.ok(!parts.some(part => part.type === 'error'))
  assert.ok(parts.some(part => part.type === 'tool-result' && part.toolName === 'web_search'))
  assert.ok(parts.some(part => part.type === 'source' && part.sourceType === 'url' && part.url === 'https://example.com/source'))
  const finish = parts.find(part => part.type === 'finish')
  assert.equal(finish?.usage.inputTokens.total, 5)
  assert.equal(finish?.usage.outputTokens.total, 2)
  if (!byok) {
    assert.equal(liteLLMCost(finish?.providerMetadata), 37981)
    assert.ok(liteLLMGenerationId(finish?.providerMetadata))
  }
})

const managedHaiku = 'anthropic/claude-haiku-5.5'
const haikuSearch = {
  prompt: [{ role: 'user' as const, content: [
    { type: 'text' as const, text: 'fixture' },
    { type: 'file' as const, mediaType: 'image/png', data: { type: 'url' as const, url: new URL('https://example.com/fixture.png') } },
  ] }],
  tools: [
    { type: 'provider' as const, id: 'anthropic.web_search_20250305' as const, name: 'web_search', args: {} },
    { type: 'function' as const, name: 'lookup', inputSchema: { type: 'object' as const, properties: {} } },
  ],
}

for (const byok of [true, false]) test(`LiteLLM preserves ${byok ? 'BYOK Messages' : 'Managed Haiku TypeSafe'} search, citations and images`, { skip }, async t => {
  setLiteLLMEnvironment(t)
  const { createLiteLLMModel, liteLLMCost, liteLLMGenerationId } = await import('../lib/model-gateway/litellm-client')
  const modelId = byok ? 'claude-haiku-5-5' : managedHaiku
  const model = createLiteLLMModel(modelId, byok ? {
    credential: { modelId, provider: 'anthropic', apiKey: 'sk-person-messages-fixture', baseUrl: provider!, nativeMessages: true },
  } : {})
  const result = await model.doStream(haikuSearch)
  const parts = await Array.fromAsync(result.stream)
  assert.ok(!parts.some(part => part.type === 'error'))
  assert.ok(parts.some(part => part.type === 'tool-result' && part.toolName === 'web_search'))
  assert.ok(parts.some(part => part.type === 'source' && part.sourceType === 'url' && part.url === 'https://example.com/source'))
  const finish = parts.find(part => part.type === 'finish')
  assert.equal(finish?.usage.inputTokens.total, 5)
  assert.equal(finish?.usage.outputTokens.total, 2)
  if (!byok) {
    assert.equal(liteLLMCost(finish?.providerMetadata), 37981)
    assert.equal(liteLLMGenerationId(finish?.providerMetadata), 'gen_01ARZ3NDEKTSV4RRFFQ69G5FAV')
    const early = parts.find(part => part.type !== 'finish' && 'providerMetadata' in part && liteLLMGenerationId(part.providerMetadata))
    assert.ok(early, 'the provider generation ID is available before finish')
    assert.equal(new Headers(result.response?.headers).has('x-litellm-call-id'), false)
  }
})

test('LiteLLM routes nonstreaming Managed Haiku search to its actual generation receipt', { skip }, async t => {
  setLiteLLMEnvironment(t)
  const { createLiteLLMModel, liteLLMCost, liteLLMGenerationId } = await import('../lib/model-gateway/litellm-client')
  const result = await createLiteLLMModel(managedHaiku).doGenerate(haikuSearch)
  assert.ok(result.content.some(part => part.type === 'tool-result' && part.toolName === 'web_search'))
  assert.ok(result.content.some(part => part.type === 'source' && part.sourceType === 'url' && part.url === 'https://example.com/source'))
  assert.equal(liteLLMCost(result.providerMetadata), 37981)
  assert.equal(liteLLMGenerationId(result.providerMetadata), 'gen_01ARZ3NDEKTSV4RRFFQ69G5FAW')
})

test('LiteLLM keeps standalone managed search and its actual cost on one response', { skip }, async t => {
  setLiteLLMEnvironment(t)
  const { createLiteLLMModel, liteLLMCost, liteLLMGenerationId } = await import('../lib/model-gateway/litellm-client')
  const { MANAGED_WEB_SEARCH_MODEL } = await import('../lib/model-gateway/provider-config')
  const result = await createLiteLLMModel(MANAGED_WEB_SEARCH_MODEL).doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
    toolChoice: { type: 'required' },
    tools: [{ type: 'provider', id: 'openai.web_search', name: 'web_search', args: { searchContextSize: 'low' } }],
  })
  assert.ok(result.content.some(part => part.type === 'tool-result' && part.toolName === 'web_search'))
  assert.ok(result.content.some(part => part.type === 'source' && part.sourceType === 'url' && part.url === 'https://example.com/source'))
  assert.equal(liteLLMCost(result.providerMetadata), 37981)
  assert.ok(liteLLMGenerationId(result.providerMetadata))
})
