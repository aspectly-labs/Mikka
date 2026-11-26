import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { context, propagation, trace } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { handleSubscriptionChat } from '../../lib/subscription-chat-bridge.ts'
import { signSubscriptionChat } from '../../lib/subscription-chat-ticket.ts'
import { createTracerProvider } from '../../lib/tracing/node.ts'
import { withRunSpan } from '../../lib/tracing/context.ts'

async function loopback(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

export async function startSubscriptionChatProcess(t, service) {
  const captured = []
  const exporter = new InMemorySpanExporter()
  const tracer = createTracerProvider({ exporter, sampleRate: 1, environment: 'test' })
  tracer.register({ propagator: new W3CTraceContextPropagator() })
  t.after(async () => { await tracer.shutdown(); trace.disable(); context.disable(); propagation.disable() })
  const masterKey = 'sk-fixture-subscription-chat'
  const callback = createServer(async (incoming, outgoing) => {
    const cancel = new AbortController()
    outgoing.on('close', () => { if (!outgoing.writableEnded) cancel.abort() })
    try {
      const chunks = []
      for await (const chunk of incoming) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString()
      assert.doesNotMatch(body + JSON.stringify(incoming.headers), /fixture-access|fixture-refresh|fixture-workload-token|sk-fixture-subscription-chat/)
      captured.push(JSON.parse(body))
      const response = await handleSubscriptionChat(new Request('http://127.0.0.1/internal/subscription/chat', {
        method: 'POST', body, headers: incoming.headers, signal: cancel.signal,
      }), service)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body) await pipeline(Readable.fromWeb(response.body), outgoing)
      else outgoing.end()
    } catch (error) {
      if (!cancel.signal.aborted && !outgoing.headersSent) outgoing.writeHead(500).end()
      else outgoing.destroy()
      if (error instanceof assert.AssertionError) t.diagnostic('Private credentials reached the subscription callback envelope')
    }
  })
  const callbackUrl = `http://127.0.0.1:${await loopback(callback)}/api/internal/subscription/chat`
  t.after(() => { callback.closeAllConnections(); return new Promise(resolve => callback.close(resolve)) })
  const binary = process.env.MIKKA_BYOS_LITELLM_BINARY
  let liteUrl
  if (binary) {
    const reserve = createTcpServer()
    const port = await loopback(reserve)
    await new Promise(resolve => reserve.close(resolve))
    liteUrl = `http://127.0.0.1:${port}`
    const child = spawn(binary, ['--config', 'deploy/litellm/config.yaml', '--host', '127.0.0.1', '--port', String(port), '--num_workers', '1'], {
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', LITELLM_MASTER_KEY: masterKey, MIKKA_SUBSCRIPTION_CPA_CHAT_URL: callbackUrl,
        LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False', AI_GATEWAY_API_KEY: 'fixture-unused-gateway-key',
        NEON_AI_GATEWAY_CHAT_URL: callbackUrl, NEON_AI_GATEWAY_TOKEN: 'fixture-unused-neon-key' },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    const stopped = once(child, 'exit').catch(() => [])
    t.after(async () => { child.kill(); await stopped })
    const health = await Promise.race([stopped.then(() => false), (async () => {
      for (let tries = 0; tries < 120; tries++) {
        const response = await fetch(liteUrl + '/health/liveliness', { signal: AbortSignal.timeout(500) }).catch(() => null)
        if (response?.ok) return true
        await delay(100)
      }
      return false
    })()])
    assert.ok(health, 'Pinned LiteLLM process did not start')
  }
  const old = { MIKKA_LITELLM_URL: process.env.MIKKA_LITELLM_URL, MIKKA_LITELLM_MASTER_KEY: process.env.MIKKA_LITELLM_MASTER_KEY }
  process.env.MIKKA_LITELLM_URL = liteUrl ?? callbackUrl
  process.env.MIKKA_LITELLM_MASTER_KEY = masterKey
  t.after(() => {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  const send = body => fetch(liteUrl ? liteUrl + '/v1/mikka/subscription/chat' : callbackUrl, {
    method: 'POST', body, headers: { 'content-type': 'application/json', ...(liteUrl ? { authorization: 'Bearer ' + masterKey } : {}) },
  })
  return {
    captured,
    realLiteLLM: Boolean(liteUrl),
    send,
    // The normal package runner still exercises the real signed callback,
    // PostgreSQL and CPA without requiring a global Python installation.
    fixtureTransport: liteUrl ? undefined : async (use, model, payload, signal) => {
      const { body } = await signSubscriptionChat(use, model, payload)
      return fetch(callbackUrl, { method: 'POST', body, signal, headers: { 'content-type': 'application/json' } })
    },
    async traceModel(work) {
      const result = await withRunSpan('scripted.subscription.chat', {}, work)
      await tracer.forceFlush()
      const spans = exporter.getFinishedSpans()
      exporter.reset()
      return { result, spans }
    },
  }
}
