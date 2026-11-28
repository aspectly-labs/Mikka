import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { subscriptionFixture } from '../tests/fixtures/subscription'
import { readGatewayReceipt } from './model-gateway/usage'

const source = 'https://example.com/source'
const encoder = new TextEncoder()
const sse = (events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')

function fixture(protocol: 'anthropic' | 'openai') {
  if (protocol === 'openai') {
    const search = { type: 'web_search_call', id: 'search-1', status: 'completed', action: { type: 'search', query: 'fixture', sources: [{ type: 'url', url: source }] } }
    const annotation = { type: 'url_citation', url: source, title: 'Public source', start_index: 0, end_index: 7 }
    const message = { type: 'message', id: 'message-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture', annotations: [annotation] }] }
    const response = { id: 'resp-1', model: 'fixture-model', created_at: 1, status: 'completed', output: [search, message], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } }
    return sse([
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } },
      { type: 'response.output_item.added', output_index: 0, item: { ...search, status: 'in_progress' } },
      { type: 'response.output_item.done', output_index: 0, item: search },
      { type: 'response.output_item.added', output_index: 1, item: message },
      { type: 'response.output_text.delta', output_index: 1, item_id: message.id, delta: 'fixture' },
      { type: 'response.output_text.annotation.added', output_index: 1, item_id: message.id, annotation },
      { type: 'response.output_item.done', output_index: 1, item: message },
      { type: 'response.completed', response },
    ])
  }
  const search = { type: 'server_tool_use', id: 'srvtoolu_fixture', name: 'web_search', input: {} }
  return sse([
    { type: 'message_start', message: { id: 'msg-fixture', model: 'fixture-model', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: search },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"fixture"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: search.id,
      content: [{ type: 'web_search_result', title: 'Public source', url: source, encrypted_content: 'fixture' }] } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: 'fixture' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', cited_text: 'fixture', url: source, title: 'Public source', encrypted_index: 'fixture' } } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ])
}

const ledger: { sql: string; params: unknown[] }[] = []
mock.module(new URL('./db/index.ts', import.meta.url).href, { namedExports: {
  pool: {}, db: { execute(statement: SQL) { ledger.push(new PgDialect().sqlToQuery(statement)); return { rows: [{ id: 'claimed' }] } } },
} })
mock.module(new URL('./search/rate-limit.ts', import.meta.url).href, { namedExports: { admitWebRequest: async () => true } })
mock.module(new URL('./subscription-runtime.ts', import.meta.url).href, { namedExports: { subscriptionRuntime() { throw new Error('Use the bound service fixture') } } })
mock.module(new URL('./run-chain.ts', import.meta.url).href, { namedExports: { readRunChain() { throw new Error('Bot calls have no native run') } } })

for (const protocol of ['anthropic', 'openai'] as const) test(`CPA Bot keeps ${protocol} search and subscription usage`, async () => {
  const { SubscriptionService } = await import('./subscription-service')
  const route = protocol === 'anthropic' ? 'claude_cpa' : 'codex_cpa'
  const { use, access } = subscriptionFixture(route)
  access.connection!.quota.observedAt = new Date().toISOString()
  const row = { id: access.connection!.id, ownerId: use.ownerId, workspaceId: use.workspaceId,
    provider: protocol === 'anthropic' ? 'claude' : 'codex', state: 'connected', epoch: '1', quota: access.connection!.quota,
    modelCatalog: { revision: '1', models: ['fixture-model'], webSearchSupport: { 'fixture-model': true } } }
  const repo = { binding: async () => ({ ...access.binding!, modelId: 'fixture-model' }), connection: async () => row, scope: () => row }
  const body = fixture(protocol)
  let wireCalls = 0
  const worker = { forUse: () => worker, modelSearchRequest: async (revision: number, request: { path: string; body: Record<string, unknown>; headers: Record<string, string> }) => {
    assert.equal(revision, 1)
    assert.equal(request.path, protocol === 'anthropic' ? '/v1/messages' : '/responses')
    assert.equal(request.body.model, 'fixture-model')
    assert.equal(request.body.stream, true)
    const tools = request.body.tools as { type?: string; name?: string }[]
    assert.equal(tools[0].type, protocol === 'anthropic' ? 'web_search_20250305' : 'web_search')
    assert.equal(tools[1].name, 'lookup')
    assert.equal(request.headers.authorization, undefined)
    wireCalls++
    return { body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(body)); controller.close() } }) }
  } }
  const service = new SubscriptionService(repo as never, () => worker as never,
    { ready: () => true, nativeIsolation: 'none' }, undefined, async () => {}, async () => {})
  assert.equal(await service.modelSearchBackend(use), protocol)
  const model = await service.model(use)
  if (model.specificationVersion !== 'v4') throw new Error('Expected v4')
  const before = ledger.length
  const options: Parameters<typeof model.doStream>[0] = {
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
    tools: [
      { type: 'provider', id: protocol === 'anthropic' ? 'anthropic.web_search_20250305' : 'openai.web_search', name: 'web_search', args: {} },
      { type: 'function', name: 'lookup', inputSchema: { type: 'object' } },
    ],
  }
  const parts = await Array.fromAsync((await model.doStream(options)).stream)
  assert.equal(parts.filter(part => part.type === 'error').length, 0)
  assert.ok(parts.some(part => part.type === 'tool-result' && part.toolName === 'web_search'))
  assert.ok(parts.some(part => part.type === 'source' && part.sourceType === 'url' && part.url === source))
  const finish = parts.find(part => part.type === 'finish')
  assert.equal(finish?.usage.inputTokens.total, 5)
  assert.equal(finish?.usage.outputTokens.total, 2)
  assert.equal(wireCalls, 1)
  assert.equal(ledger.length - before, 2)
  assert.match(ledger[before].sql, /'subscription','unknown'/)
  assert.deepEqual(ledger[before + 1].params.slice(0, 5), ['settled', protocol === 'anthropic' ? 'msg-fixture' : 'resp-1', null, 5, 2])
  assert.equal(readGatewayReceipt(protocol, body).cost, null)
  row.modelCatalog.webSearchSupport['fixture-model'] = false
  await assert.rejects(async () => model.doStream(options), /subscription_generation_failed|binding_mismatch/)
  assert.equal(wireCalls, 1)
})
