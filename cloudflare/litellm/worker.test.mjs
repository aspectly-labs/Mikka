import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const modules = {
  'cloudflare:workers': 'export class WorkerEntrypoint {}',
  '@cloudflare/containers': `
    export class Container {
      constructor(ctx, env) { this.ctx = ctx; this.env = env }
      async startAndWaitForPorts(port, { abort, portReadyTimeoutMS = 20_000 }) {
        assertPort(port)
        abort.throwIfAborted()
        if (portReadyTimeoutMS < 27_000) throw Error('fixture port did not open before its deadline')
      }
    }
    function assertPort(port) { if (port !== 4000) throw Error('unexpected port') }
    export function getContainer() {}
    export class ContainerProxy {}
  `,
}
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(modules, specifier)) return { url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]), shortCircuit: true }
  return nextResolve(specifier, context)
}})
const { LiteLlm } = await import('./worker.mjs')
hooks.deregister()

test('a cold LiteLLM port can open after the default deadline without losing request cancellation', async () => {
  const container = new LiteLlm({}, { LITELLM_MASTER_KEY: 'synthetic-key-for-isolated-test-only' })
  const abort = new AbortController()
  await container.startAndWaitForPorts(4000, { abort: abort.signal })
  abort.abort()
  await assert.rejects(container.startAndWaitForPorts(4000, { abort: abort.signal }), { name: 'AbortError' })
})

test('LiteLLM intercepts the internal callback before the container starts', async () => {
  const calls = []
  const outbound = {}
  const ctx = { exports: { SubscriptionChatOutbound: outbound }, container: { interceptOutboundHttps(...args) { calls.push(args) } } }
  const container = new LiteLlm(ctx, { LITELLM_MASTER_KEY: 'synthetic-key-for-isolated-test-only',
    SUBSCRIPTION_API: {}, MIKKA_SUBSCRIPTION_CPA_CHAT_URL: 'https://outside.example.invalid' })
  assert.equal(container.envVars.MIKKA_SUBSCRIPTION_CPA_CHAT_URL, 'https://subscription-chat.internal/mikka/api/internal/subscription/chat')
  assert.equal(container.envVars.MIKKA_LITELLM_PRIVATE_CA_FILE, '/etc/cloudflare/certs/cloudflare-containers-ca.crt')
  await container.startAndWaitForPorts(4000, { abort: new AbortController().signal })
  assert.deepEqual(calls, [['subscription-chat.internal', outbound]])
})
