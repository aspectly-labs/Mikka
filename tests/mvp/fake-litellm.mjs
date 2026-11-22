// The one fake LiteLLM. scripts/dev-local's routes extension and the mvp
// fixture server (tests/mvp/services.mjs) both mount these routes, so the
// LiteLLM boundary has exactly one scripted implementation: OpenAI
// chat/responses, Anthropic messages, transcriptions, decisions and the
// provider /models probe the key seeder verifies against. No production code
// changes and no live model key: dev-local points MIKKA_LITELLM_URL here.
import { randomUUID } from 'node:crypto'
import { MVP_SERVICES } from './isolated-env.mjs'

/** The placeholder LiteLLM service and key; never a live model credential. */
export const LOCAL_LITELLM_KEY = 'mikka-local-litellm'
export const LOCAL_LITELLM_URL = `${MVP_SERVICES}/litellm`
/** The placeholder provider key the local seeder stores; the fake /models probe accepts only it. */
export const LOCAL_DEEPSEEK_KEY = 'mikka-local-scripted-key'

/**
 * A scripted model. A user message `/tool <name> <json>` calls that registered
 * tool; a tool result is reported back as JSON; anything else is echoed.
 */
export function localModelAnswer(request) {
  const prompt = request.prompt ?? []
  const last = prompt.at(-1)
  if (last?.role === 'tool') {
    const results = (last.content ?? []).filter(part => part.type === 'tool-result')
    const summary = results.map(part => `${part.toolName}: ${JSON.stringify(part.output?.value ?? part.output ?? null).slice(0, 2000)}`).join('\n')
    return { content: [{ type: 'text', text: summary || 'ok' }], finishReason: 'stop' }
  }
  const text = textOf(prompt.findLast(message => message.role === 'user')).trim()
  const command = /^\/tool\s+([\w.-]+)\s*([\s\S]*)$/.exec(text.split('\n').findLast(line => line.startsWith('/tool ')) ?? '')
  if (command) {
    const [, toolName, raw] = command
    if (!request.tools?.some(tool => tool.name === toolName))
      return { content: [{ type: 'text', text: `Local model: no tool named ${toolName}. Tools: ${(request.tools ?? []).map(tool => tool.name).join(', ')}` }], finishReason: 'stop' }
    let input
    try { input = raw.trim() ? JSON.parse(raw) : {} } catch { return { content: [{ type: 'text', text: 'Local model: the tool input is not JSON.' }], finishReason: 'stop' } }
    return { content: [{ type: 'tool-call', toolCallId: `local-${randomUUID()}`, toolName, input: JSON.stringify(input) }], finishReason: 'tool-calls' }
  }
  return { content: [{ type: 'text', text: `Local model: ${text || '(empty)'}` }], finishReason: 'stop' }
}

const textOf = message => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).filter(part => part.type === 'text' || part.type === 'input_text').map(part => part.text).join('\n')

/** An OpenAI chat-completions request read as the scripted model's prompt. */
export function chatCompletionPrompt(body) {
  const names = new Map()
  for (const message of body.messages ?? []) for (const call of message.tool_calls ?? []) names.set(call.id, call.function?.name)
  const prompt = (body.messages ?? []).map(message => message.role === 'tool'
    ? { role: 'tool', content: [{ type: 'tool-result', toolName: names.get(message.tool_call_id) ?? 'tool', output: { value: message.content } }] }
    : { role: message.role, content: message.content })
  return { prompt, tools: (body.tools ?? []).map(tool => ({ name: tool.function?.name })) }
}

/** The scripted answer as an OpenAI chat completion, or its server-sent chunks. */
export function chatCompletion(answer, model, stream, cost = 0) {
  const id = `local-${randomUUID()}`, created = Math.floor(Date.now() / 1000)
  const text = answer.content.filter(part => part.type === 'text').map(part => part.text).join('')
  const calls = answer.content.filter(part => part.type === 'tool-call')
    .map((part, index) => ({ index, id: part.toolCallId, type: 'function', function: { name: part.toolName, arguments: part.input } }))
  const finish = answer.finishReason === 'tool-calls' ? 'tool_calls' : 'stop'
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, ...(cost ? { cost } : {}) }
  if (!stream) return { id, object: 'chat.completion', created, model, usage,
    choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) } }] }
  const chunk = (delta, finishReason = null, extra = {}) => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra })
  return [
    chunk({ role: 'assistant' }),
    ...(text.match(/[\s\S]{1,24}/g) ?? []).map(content => chunk({ content })),
    ...(calls.length ? [chunk({ tool_calls: calls })] : []),
    chunk({}, finish, { usage }),
  ]
}

/** Decision API answers: the first choice, or probability 0.5. */
export function localDecision(input) {
  return {
    model: input.model,
    answers: (input.questions ?? []).map(question => question.type === 'choice'
      ? { type: 'choice', name: question.name, choice: question.choices?.[0]?.value }
      : { type: 'predicate', name: question.name, probability: 0.5 }),
  }
}

/** A prompt read from Anthropic Messages or OpenAI Responses bodies for the scripted model. */
function anthropicPrompt(body) {
  const prompt = (body.messages ?? []).map(message => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content }))
  return { prompt: [...(body.system ? [{ role: 'system', content: typeof body.system === 'string' ? body.system : textOf({ content: body.system }) }] : []), ...prompt], tools: (body.tools ?? []).map(tool => ({ name: tool.name })) }
}
function responsesPrompt(body) {
  // A Responses request may carry a bare string input instead of item objects.
  const items = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : (body.input ?? [])
  const prompt = items.map(item => ({ role: item.role ?? 'user', content: item.content ?? (typeof item === 'string' ? item : '') }))
  return { prompt, tools: (body.tools ?? []).map(tool => ({ name: tool.name })) }
}

/** Scenario scripting: POST /litellm/scenarios registers a fault/cost matched
 * by model alias plus a marker substring anywhere in the request body. */
export function createLiteLLMScenarios() {
  const scenarios = []
  const match = body => {
    const raw = JSON.stringify(body)
    return scenarios.find(item => (item.model === undefined || item.model === body.model) && raw.includes(item.marker))
  }
  return { scenarios, match }
}

/** Mounted on the fake-service process: true when the request was answered.
 * Covers /litellm/v1/* (the real client surface) and /deepseek/models (the
 * provider probe the local key seeder verifies against). */
export function fakeLiteLLMRoutes(scenarios) {
  const state = scenarios ?? createLiteLLMScenarios()
  return async function routes(request, response, url, { readBody, json, log } = {}) {
    const reply = json ?? ((value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); return true })
    // The native model gateway authenticates with x-litellm-api-key (upstream.ts);
    // the plain Authorization header is the other accepted form.
    const bearer = (request.headers['x-litellm-api-key'] ?? request.headers.authorization ?? '').replace(/^Bearer /, '')
    if (url.pathname === '/litellm/scenarios') {
      if (request.method !== 'POST') return reply({ error: { message: 'method' } }, 405)
      const input = await readBody(request)
      if (typeof input.marker !== 'string' || !input.marker) return reply({ error: { message: 'marker required' } }, 400)
      state.scenarios.push(input)
      return reply({ armed: true, count: state.scenarios.length })
    }
    if (url.pathname === '/deepseek/models' && request.method === 'GET') {
      if (bearer !== LOCAL_DEEPSEEK_KEY) return reply({ error: { message: 'unknown key', type: 'authentication_error' } }, 401)
      return reply({ data: [{ id: 'deepseek-v4.1-flash', object: 'model' }] })
    }
    if (!url.pathname.startsWith('/litellm/')) return false
    response.setHeader('x-litellm-call-id', `local-${randomUUID()}`)
    response.setHeader('x-litellm-response-cost', '0')
    if (bearer !== LOCAL_LITELLM_KEY) return reply({ error: { message: 'unknown key', type: 'authentication_error' } }, 401)
    if (url.pathname === '/litellm/v1/models' && request.method === 'GET')
      return reply({ data: ['mikka-default', 'mikka-title', 'mikka-decision', 'mikka-planning'].map(id => ({ id })) })
    if (url.pathname === '/litellm/v1/decisions' && request.method === 'POST')
      return reply(localDecision(await readBody(request)))
    if (url.pathname === '/litellm/v1/audio/transcriptions' && request.method === 'POST')
      return reply({ text: 'local transcription' })
    if (!['/litellm/v1/chat/completions', '/litellm/v1/messages', '/litellm/v1/responses'].includes(url.pathname) || request.method !== 'POST')
      return reply({ error: { message: 'No local model substitute for this route', type: 'not_found' } }, 404)
    const body = await readBody(request)
    const scenario = state.match(body)
    const cost = typeof scenario?.cost === 'number' ? scenario.cost : 0
    response.setHeader('x-litellm-response-cost', String(cost))
    if (scenario?.fault === '429') return reply({ error: { message: 'local scripted rate limit', type: 'rate_limit_error' } }, 429)
    if (scenario?.fault === '500') return reply({ error: { message: 'local scripted upstream failure', type: 'internal_server_error' } }, 500)
    if (scenario?.fault === 'timeout') {
      // Hold until the caller gives up; never answer. Matches a hung upstream.
      await new Promise(resolve => { request.once('close', resolve) })
      return true
    }
    const prompt = url.pathname === '/litellm/v1/messages' ? anthropicPrompt(body) : url.pathname === '/litellm/v1/responses' ? responsesPrompt(body) : chatCompletionPrompt(body)
    const answer = localModelAnswer(prompt)
    const text = answer.content.filter(part => part.type === 'text').map(part => part.text).join('')
    if (url.pathname === '/litellm/v1/chat/completions') {
      if (!body.stream) return reply(chatCompletion(answer, body.model, false, cost))
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const part of chatCompletion(answer, body.model, true, cost)) response.write(`data: ${JSON.stringify(part)}\n\n`)
      return response.end('data: [DONE]\n\n')
    }
    if (url.pathname === '/litellm/v1/messages') {
      const message = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
      if (!body.stream) return reply(message)
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
      event('message_start', { type: 'message_start', message })
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
      event('content_block_stop', { type: 'content_block_stop', index: 0 })
      event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
      event('message_stop', { type: 'message_stop' })
      return response.end()
    }
    const completion = { id: `resp_${randomUUID()}`, object: 'response', status: 'completed', model: body.model,
      output: [{ id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    if (!body.stream) return reply(completion)
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`)
    response.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completion })}\n\n`)
    return response.end()
  }
}
