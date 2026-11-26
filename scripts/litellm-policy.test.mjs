import assert from 'node:assert/strict'
import test from 'node:test'
import { auditLiteLlmSource } from './litellm-policy.mjs'

test('rejects a direct model request and renamed SDK factories outside the LiteLLM client', () => {
  for (const source of [
    `fetch('https://api.openai.com/v1/responses')`,
    `fetch(\`https://api.cloudflare.com/client/v4/accounts/\${account}/ai/v1/chat/completions\`)`,
    `createOpenAICompatible({ baseURL: endpoint, apiKey })`,
    `gateway('model')`,
    `import { createOpenAI as provider } from '@ai-sdk/openai'; provider({ baseURL: endpoint })`,
    `import Direct from 'openai'; new Direct({ apiKey })`,
    `generateText({ model: 'openai/gpt-6-luna', prompt })`,
    `import { openai } from '@ai-sdk/openai'; openai('model')`,
    `const provider = await import('@ai-sdk/openai')`,
    `import { gateway as provider } from 'ai'; provider('model')`,
  ]) assert.ok(auditLiteLlmSource('lib/model-call.ts', source).length, source)
})

test('permits only the designated client, ordinary gateway methods, and account or routing metadata', () => {
  assert.deepEqual(auditLiteLlmSource('lib/model-gateway/litellm-client.ts', `createOpenAI({ baseURL: url })`), [])
  assert.deepEqual(auditLiteLlmSource('lib/model-call.ts', `modelAdmission.gateway(scope, model)`), [])
  assert.deepEqual(auditLiteLlmSource('lib/model-call.ts', `import { GatewayError } from '@ai-sdk/gateway'`), [])
  assert.deepEqual(auditLiteLlmSource('packages/daemon/src/quota/claude.ts', `const url = 'https://api.anthropic.com/api/oauth/usage'`), [])
  assert.ok(auditLiteLlmSource('packages/daemon/src/quota/claude.ts', `createAnthropic({})`).length)
})

test('rejects the retired subscription SDK shim at its original production path', () => {
  const source = `import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
    createOpenAICompatible({ baseURL: 'https://mikka.invalid/v1', fetch: streamToSubscriptionWorker })`
  const errors = auditLiteLlmSource('lib/subscription-service.ts', source)
  assert.deepEqual(errors.map(item => item.reason), [
    'provider SDK imports belong in the LiteLLM client',
    'model SDK construction belongs in the LiteLLM client',
  ])
})

test('subscription inference endpoints are routing metadata and cannot hide in quota probes', () => {
  for (const [quotaFile, endpoint, constant] of [
    ['claude', 'https://api.anthropic.com/v1/messages', 'CLAUDE_SUBSCRIPTION_ENDPOINT'],
    ['codex', 'https://chatgpt.com/backend-api/codex/responses', 'CODEX_SUBSCRIPTION_ENDPOINT'],
  ]) {
    const contract = 'lib/model-admission/contract.ts'
    assert.deepEqual(auditLiteLlmSource(contract, `export const ${constant} = '${endpoint}'`), [])
    for (const file of [contract, `packages/daemon/src/quota/${quotaFile}.ts`]) {
      assert.equal(auditLiteLlmSource(file, `fetch('${endpoint}')`).length, 1)
      assert.equal(auditLiteLlmSource(file, `globalThis.fetch(${constant}, { method: 'POST' })`).length, 1)
    }
  }
})

test('the native Go broker rejects the retired provider-direct endpoints', () => {
  const native = 'packages/subscription-worker/native_broker.go'
  const old = `endpoint := "https://api.anthropic.com" + request.Path
endpoint = "https://chatgpt.com/backend-api/codex/responses"`
  assert.deepEqual(auditLiteLlmSource(native, old).map(item => item.line), [1, 2])
  assert.deepEqual(auditLiteLlmSource(native, `endpoint := base + "/v1/mikka/subscription/codex/responses"`), [])
  assert.deepEqual(auditLiteLlmSource('packages/subscription-worker/plain_model.go', old), [])
  assert.deepEqual(auditLiteLlmSource('packages/subscription-worker/quota.go',
    `endpoint := "https://api.anthropic.com/api/oauth/usage"`), [])
})
