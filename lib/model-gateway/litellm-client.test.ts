import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { GatewayError } from '@ai-sdk/gateway'
import { createLiteLLMModel, createLiteLLMTranscriptionModel, liteLLMCost, liteLLMGenerationId, liteLLMResponseCost } from './litellm-client'

const original = { MIKKA_LITELLM_URL: process.env.MIKKA_LITELLM_URL, MIKKA_LITELLM_MASTER_KEY: process.env.MIKKA_LITELLM_MASTER_KEY }

async function atProxy(t: TestContext, receiver: typeof fetch, run: () => Promise<void>) {
  process.env.MIKKA_LITELLM_URL = 'https://proxy.example/v1'
  process.env.MIKKA_LITELLM_MASTER_KEY = 'test-proxy-key'
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  t.mock.method(globalThis, 'fetch', receiver)
  await run()
}

const prompt: Parameters<ReturnType<typeof createLiteLLMModel>['doStream']>[0]['prompt'] = [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }]
const chunk = { id: 'model-response-id', object: 'chat.completion.chunk', created: 1, model: 'fixture/model' }
const haiku = 'anthropic/claude-haiku-5.5'
const haikuGeneration = 'gen_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const haikuOptions = () => ({ prompt: structuredClone(prompt), tools: [
  { type: 'provider' as const, id: 'anthropic.web_search_20250305' as const, name: 'web_search', args: {} },
] })

function haikuStream(generationId = haikuGeneration) {
  const events = [
    { type: 'text-start', id: 'text-id', providerMetadata: { gateway: { generationId } } },
    { type: 'raw', rawValue: { usage: { cost: 0 } } },
    { type: 'text-delta', id: 'text-id', delta: 'found' },
    { type: 'text-end', id: 'text-id' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage: { inputTokens: { total: 8 }, outputTokens: { total: 3 } } },
  ]
  return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), {
    headers: { 'content-type': 'text/event-stream', 'x-litellm-call-id': 'proxy-placeholder', 'x-litellm-response-cost': '0' },
  })
}

test('Managed Haiku forwards search through the pinned TypeSafe path and settles the retried actual receipt', async t => {
  let reads = 0
  await atProxy(t, async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://proxy.example')
    assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), init?.method === 'POST'
      ? { authorization: 'Bearer test-proxy-key', 'content-type': 'application/json' }
      : { authorization: 'Bearer test-proxy-key' })
    if (init?.method === 'POST') {
      assert.equal(url.pathname, '/v1/mikka/managed-search/haiku/stream/language-model')
      const body = JSON.parse(String(init.body))
      assert.deepEqual(body.custom_body.tools, haikuOptions().tools)
      assert.equal(body.stream, true)
      assert.equal(body.custom_body.providerOptions, undefined)
      assert.equal(body.custom_body.headers, undefined)
      return haikuStream()
    }
    assert.equal(url.pathname + url.search, '/v1/mikka/gateway-generation?id=' + haikuGeneration)
    assert.equal(init?.redirect, 'error')
    return ++reads === 1 ? new Response(null, { status: 404 }) : Response.json({ data: {
      id: haikuGeneration, model: haiku, is_byok: false, total_cost: 0.037981, billable_web_search_calls: 1,
    } })
  }, async () => {
    const result = await createLiteLLMModel(haiku).doStream({ ...haikuOptions(), headers: { 'x-caller-private': 'ignored' },
      providerOptions: { gateway: { order: ['ignored'] } } })
    assert.equal(new Headers(result.response?.headers).has('x-litellm-call-id'), false)
    const reader = result.stream.getReader()
    const early = (await reader.read()).value
    assert.equal(early?.type, 'text-start')
    assert.equal(early?.type === 'text-start' && liteLLMGenerationId(early.providerMetadata), haikuGeneration)
    assert.equal(reads, 0)
    let finish
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      if (next.value.type === 'finish') finish = next.value
    }
    assert.equal(liteLLMGenerationId(finish?.providerMetadata), haikuGeneration)
    assert.equal(liteLLMCost(finish?.providerMetadata), 37981)
    assert.equal(reads, 2)
  })
})

test('Managed Haiku keeps its generation ID when the Gateway receipt describes another call', async t => {
  await atProxy(t, async (_input, init) => init?.method === 'POST' ? haikuStream() : Response.json({ data: {
    id: haikuGeneration, model: haiku, is_byok: true, total_cost: 0,
  } }), async () => {
    const result = await createLiteLLMModel(haiku).doStream(haikuOptions())
    const finish = (await Array.fromAsync(result.stream)).find(part => part.type === 'finish')
    assert.equal(liteLLMGenerationId(finish?.providerMetadata), haikuGeneration)
    assert.equal(liteLLMCost(finish?.providerMetadata), null)
  })
})

for (const operation of ['doGenerate', 'doStream'] as const) test(`Managed Haiku ${operation} exposes the SDK generation ID on an HTTP failure`, async t => {
  await atProxy(t, async (_input, init) => {
    assert.equal(init?.method, 'POST')
    return Response.json({ error: { type: 'internal_server_error', message: 'fixture provider failed' }, generationId: haikuGeneration }, { status: 502 })
  }, async () => {
    await assert.rejects(async () => createLiteLLMModel(haiku)[operation](haikuOptions()), (error: unknown) =>
      GatewayError.isInstance(error) && error.statusCode === 502 && error.generationId === haikuGeneration)
  })
})

test('Managed Haiku preserves the canonical ID on a Gateway stream error before any content', async t => {
  await atProxy(t, async (_input, init) => {
    assert.equal(init?.method, 'POST')
    return new Response('data: ' + JSON.stringify({ type: 'error', error: { message: 'fixture provider failed', generationId: haikuGeneration } }) + '\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    })
  }, async () => {
    const result = await createLiteLLMModel(haiku).doStream(haikuOptions())
    const [part] = await Array.fromAsync(result.stream)
    assert.equal(part?.type, 'error')
    assert.equal(part && 'providerMetadata' in part && liteLLMGenerationId(part.providerMetadata), haikuGeneration)
  })
})

test('cancelling Managed Haiku after content aborts its pending receipt read', async t => {
  const started = Promise.withResolvers<AbortSignal>()
  await atProxy(t, async (_input, init) => {
    if (init?.method === 'POST') return haikuStream()
    const signal = init?.signal
    assert.ok(signal)
    started.resolve(signal)
    return new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }, async () => {
    const result = await createLiteLLMModel(haiku).doStream(haikuOptions())
    const reader = result.stream.getReader()
    const early = (await reader.read()).value
    assert.equal(early?.type === 'text-start' && liteLLMGenerationId(early.providerMetadata), haikuGeneration)
    assert.equal((await reader.read()).value?.type, 'text-delta')
    assert.equal((await reader.read()).value?.type, 'text-end')
    const finish = reader.read()
    const signal = await started.promise
    await reader.cancel('client stopped')
    assert.equal(signal.aborted, true)
    assert.equal((await finish).done, true)
  })
})

test('a reserved hosted call carries its own internal identity without replacing the original response receipt', async t => {
  const callId = 'mikka-hosted:00000000-0000-4000-8000-000000000001:wrun_native:step_model:1'
  await atProxy(t, async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('x-litellm-call-id'), callId)
    return Response.json({ id: 'provider-completion', object: 'chat.completion', created: 1, model: 'fixture/model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 } }, {
      headers: { 'x-litellm-call-id': callId, 'x-litellm-response-cost': '0.0000025' },
    })
  }, async () => {
    const result = await createLiteLLMModel('fixture/model', { user: 'workspace-fixture', callId }).doGenerate({ prompt: structuredClone(prompt) })
    assert.equal(liteLLMGenerationId(result.providerMetadata), callId)
    assert.equal(liteLLMCost(result.providerMetadata), 3)
    assert.equal(result.content[0].type, 'text')
  })
})

test('stream settlement reads the final usage cost, not the initial receipt placeholder', async t => {
  const events = [
    { ...chunk, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
    { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { ...chunk, choices: [], usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8, cost: 0.0000025 } },
  ]
  await atProxy(t, async (input, init) => {
    assert.equal(String(input), 'https://proxy.example/v1/chat/completions')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-proxy-key')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.model, 'mikka-credits/fixture/model')
    assert.equal(body.user, 'workspace-fixture')
    assert.equal(body.stream_options.include_usage, true)
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream', 'x-litellm-call-id': 'proxy-call', 'x-litellm-response-cost': '0' },
    })
  }, async () => {
    const result = await createLiteLLMModel('fixture/model', { user: 'workspace-fixture' }).doStream({ prompt: structuredClone(prompt) })
    const parts = await Array.fromAsync(result.stream)
    const finish = parts.find(part => part.type === 'finish')
    assert.equal(liteLLMCost(finish?.providerMetadata), 3)
    assert.equal(liteLLMGenerationId(finish?.providerMetadata), 'proxy-call')
    assert.equal(finish?.usage.inputTokens.total, 6)
    assert.ok(parts.every(part => part.type !== 'raw'))
  })
})

for (const returnedId of [undefined, 'another-proxy-call']) test(`a ${returnedId ? 'mismatched' : 'missing'} correlation ACK preserves the real stream and settled cost`, async t => {
  const callId = 'mikka-hosted:00000000-0000-4000-8000-000000000001:wrun_native:step_model:1'
  await atProxy(t, async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('x-litellm-call-id'), callId)
    const events = [
      { ...chunk, choices: [{ index: 0, delta: { content: 'paid content' }, finish_reason: null }] },
      { ...chunk, choices: [], usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8, cost: 0.0000025 } },
    ]
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream', ...(returnedId ? { 'x-litellm-call-id': returnedId } : {}) },
    })
  }, async () => {
    const result = await createLiteLLMModel('fixture/model', { callId }).doStream({ prompt: structuredClone(prompt) })
    const parts = await Array.fromAsync(result.stream)
    assert.ok(parts.some(part => part.type === 'text-delta' && part.delta === 'paid content'))
    const finish = parts.find(part => part.type === 'finish')
    assert.equal(liteLLMCost(finish?.providerMetadata), 3)
    assert.equal(liteLLMGenerationId(finish?.providerMetadata), returnedId)
  })
})

test('caller headers cannot supply a hosted identity without an actual server reservation', async t => {
  await atProxy(t, async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('x-litellm-call-id'), null)
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }, async () => {
    const result = await createLiteLLMModel('fixture/model').doStream({ prompt: structuredClone(prompt),
      headers: { 'x-litellm-call-id': 'mikka-hosted:00000000-0000-4000-8000-000000000001' } })
    await result.stream.pipeTo(new WritableStream())
  })
})

test('transcription keeps the provider credential in the private proxy request', async t => {
  const credential = { modelId: 'whisper-1', provider: 'openai' as const, apiKey: 'person-key', baseUrl: 'https://provider.example/v1' }
  await atProxy(t, async (input, init) => {
    assert.equal(String(input), 'https://proxy.example/v1/audio/transcriptions')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-proxy-key')
    assert.equal(new Headers(init?.headers).get('x-litellm-num-retries'), '0')
    assert.ok(init?.body instanceof FormData)
    assert.equal(init.body.get('model'), 'openai/whisper-1')
    assert.equal(init.body.get('api_key'), 'person-key')
    assert.equal(init.body.get('api_base'), 'https://provider.example/v1')
    assert.equal(init.body.get('num_retries'), null)
    return Response.json({ text: 'fixture transcript' })
  }, async () => {
    const result = await createLiteLLMTranscriptionModel('whisper-1', credential).doGenerate({
      audio: Uint8Array.of(1, 2, 3), mediaType: 'audio/wav',
    })
    assert.equal(result.text, 'fixture transcript')
  })
})

test('proxy cost is rounded up to microdollars and malformed receipts are unknown', () => {
  assert.equal(liteLLMResponseCost({ 'x-litellm-response-cost': '0.0000001' }), 1)
  assert.equal(liteLLMResponseCost({ 'x-litellm-response-cost': '-0.0000001' }), null)
  assert.equal(liteLLMResponseCost(undefined), null)
})

test('a Pro chat calls Responses with only the frozen reasoning mode', async t => {
  await atProxy(t, async (input, init) => {
    assert.equal(String(input), 'https://proxy.example/v1/responses')
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(body.reasoning, { mode: 'pro' })
    assert.equal(body.service_tier, undefined)
    return Response.json({ id: 'test-response', object: 'response', status: 'completed', created_at: 1,
      model: 'gpt-6.2-astra', output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } })
  }, async () => {
    await createLiteLLMModel('openai/gpt-6.2-astra', { pro: true }).doGenerate({ prompt: structuredClone(prompt) })
    assert.throws(() => createLiteLLMModel('anthropic/claude-fixture', { pro: true }), /model_pro_unavailable/)
  })
})

test('Daybreak chat calls OpenAI Responses with access_programs.cyber on OpenAI BYOK only', async t => {
  const seen: Record<string, unknown>[] = []
  await atProxy(t, async (input, init) => {
    assert.equal(String(input), 'https://proxy.example/v1/responses')
    seen.push(JSON.parse(String(init?.body)))
    return Response.json({ id: 'test-response', object: 'response', status: 'completed', created_at: 1,
      model: 'gpt-6-cyber', output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } })
  }, async () => {
    const byok = { apiKey: 'sk-openai', baseUrl: 'https://api.openai.com/v1', provider: 'openai' as const, modelId: 'gpt-6-cyber' }
    await createLiteLLMModel('openai/gpt-6-cyber', { credential: byok, cyberAccessProgram: 'daybreak_blue' }).doGenerate({ prompt: structuredClone(prompt) })
    await createLiteLLMModel('openai/gpt-6.2-astra', { credential: { ...byok, modelId: 'gpt-6.2-astra' }, pro: true, cyberAccessProgram: 'daybreak_red' }).doGenerate({ prompt: structuredClone(prompt) })
    assert.throws(() => createLiteLLMModel('openai/gpt-6-cyber', { cyberAccessProgram: 'daybreak_blue' }), /model_daybreak_unavailable/)
    assert.throws(() => createLiteLLMModel('anthropic/claude-fixture', { credential: { ...byok, provider: 'anthropic' }, cyberAccessProgram: 'daybreak_blue' }), /model_daybreak_unavailable/)
  })
  assert.deepEqual(seen[0].access_programs, { cyber: 'daybreak_blue' })
  assert.deepEqual(seen[1].access_programs, { cyber: 'daybreak_red' })
  assert.deepEqual(seen[1].reasoning, { mode: 'pro' })
})

test('OpenAI BYOK sends native search and ordinary tools together through LiteLLM Responses', async t => {
  const modelId = 'gpt-5.5'
  const url = 'https://example.com/source'
  const request = {
    prompt: structuredClone(prompt),
    tools: [
      { type: 'provider' as const, id: 'openai.web_search' as const, name: 'web_search', args: {} },
      { type: 'function' as const, name: 'lookup', inputSchema: { type: 'object' as const, properties: {} } },
    ],
  }
  let calls = 0
  await atProxy(t, async (input, init) => {
    calls++
    assert.equal(String(input), 'https://proxy.example/v1/responses')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('authorization'), 'Bearer test-proxy-key')
    assert.equal(headers.get('x-litellm-api-key'), 'Bearer test-proxy-key')
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(body.tools.map((tool: { type: string }) => tool.type), ['web_search', 'function'])
    assert.equal(body.tools[1].name, 'lookup')
    assert.equal(body.model, 'openai/gpt-5.5')
    assert.equal(body.api_key, 'person-key')
    assert.equal(body.disable_fallbacks, true)
    assert.equal(body.store, false)
    assert.ok(body.include.includes('web_search_call.action.sources'))
    return Response.json({
      id: 'search-response', object: 'response', status: 'completed', created_at: 1, model: modelId,
      output: [
        { type: 'web_search_call', id: 'search-call', status: 'completed', action: { type: 'search', query: 'fixture', sources: [{ type: 'url', url }] } },
        { type: 'message', id: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture', annotations: [{ type: 'url_citation', start_index: 0, end_index: 7, title: 'Public source', url }] }] },
      ],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    })
  }, async () => {
    const credential = { modelId, provider: 'openai' as const, apiKey: 'person-key', baseUrl: 'https://api.openai.com/v1' }
    await assert.rejects(async () => createLiteLLMModel(modelId, { credential }).doGenerate(request), /model_native_web_search_unavailable/)
    const result = await createLiteLLMModel(modelId, { credential: { ...credential, nativeResponses: true } }).doGenerate(request)
    assert.equal(result.usage.inputTokens.total, 5)
    assert.equal(result.usage.outputTokens.total, 2)
    assert.ok(result.content.some(part => part.type === 'source' && part.sourceType === 'url' && part.url === url))
    assert.ok(result.content.some(part => part.type === 'tool-result' && part.toolName === 'web_search'))
  })
  assert.equal(calls, 1)
})
