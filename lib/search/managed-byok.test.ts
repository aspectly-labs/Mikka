import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { hostedBillingScope } from '../abuse/context'

const ownerId = 'fixture-user'
const workspaceId = '729d57d7-4ccc-4ae7-8bf2-3f221289f449'
const botId = '69edfa2c-e567-48d5-b48c-da0f2899c946'
const keyId = '3c9e77c1-214e-4443-af2c-ec972813906f'
const selection = { type: 'api_key' as const, ownerId, workspaceId, consumerId: botId, keyId, modelId: 'fixture/model' }
let optedIn = false
let modelAvailable = true
let nativeAvailable = false
let currentWorkspace = workspaceId
const calls: { id: string | undefined; tools: unknown; model: string }[] = []
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: {} } })
mock.module(new URL('../execution-settings.ts', import.meta.url).href, { namedExports: {
  executionWorkspace: async () => currentWorkspace,
} })
mock.module(new URL('../model-api-keys.ts', import.meta.url).href, { namedExports: {
  apiKeyPreferences: async () => ({ apiKeyWebSearch: optedIn }),
  usableApiKeys: async () => modelAvailable ? [{ models: [selection.modelId] }] : [],
} })
mock.module(new URL('../model-api-key-chat.ts', import.meta.url).href, { namedExports: {
  apiKeyNativeSearchBackend: async () => nativeAvailable ? 'openai' : undefined,
} })
mock.module(new URL('../abuse/runtime.ts', import.meta.url).href, { namedExports: { hostedUsage: { metered: true } } })
mock.module(new URL('../abuse/model.ts', import.meta.url).href, { namedExports: {
  hostedModel: async (workspace: string, model: string) => {
    assert.equal(workspace, workspaceId)
    return { doGenerate: async (args: { tools: unknown; toolChoice: unknown }) => {
      const scope = hostedBillingScope.getStore()
      assert.equal(scope?.actorId, ownerId)
      assert.deepEqual(args.toolChoice, { type: 'required' })
      if (calls.some(call => call.id === scope?.byokWebSearchId)) throw new Error('usage_in_progress')
      calls.push({ id: scope?.byokWebSearchId, tools: args.tools, model })
      return { content: [
        { type: 'tool-result', toolName: 'web_search' },
        { type: 'text', text: 'Source claims in generated prose are excluded.' },
        { type: 'source', sourceType: 'url', url: 'https://example.com/result', title: 'Public source' },
        { type: 'source', sourceType: 'url', url: 'http://127.0.0.1/secret', title: 'Unsafe source' },
      ] }
    } }
  },
} })

test('paid BYOK search needs live opt-in, Bot scope, a usable key and no native route', async () => {
  const { managedByokSearch } = await import('./managed-byok')
  const input = { query: 'fixture' }
  const request = { ownerId, botId, selection, execution: 'fixture-execution', callId: 'tool-call' }
  assert.equal((await managedByokSearch(input, request)).ok, false)
  optedIn = true
  nativeAvailable = true
  assert.equal((await managedByokSearch(input, request)).ok, false)
  nativeAvailable = false
  modelAvailable = false
  assert.equal((await managedByokSearch(input, request)).ok, false)
  modelAvailable = true
  currentWorkspace = 'other-workspace'
  assert.equal((await managedByokSearch(input, request)).ok, false)
  currentWorkspace = workspaceId
  assert.equal((await managedByokSearch(input, { ...request, signal: AbortSignal.abort() })).ok, false)
  assert.equal(calls.length, 0)

  const results = await managedByokSearch(input, request)
  assert.ok(results.ok)
  assert.deepEqual(results.results, [{ url: 'https://example.com/result', title: 'Public source', snippet: '' }])
  await assert.rejects(managedByokSearch(input, request), /usage_in_progress/)
  assert.equal(calls.length, 1)
  assert.match(calls[0].id ?? '', /^[a-f0-9-]{36}$/)
  assert.equal(calls[0].model, 'openai/gpt-6-luna')
})
