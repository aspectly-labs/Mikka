import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { subscriptionChatPath, subscriptionChatRequest, subscriptionChatUrl } from './subscription-chat.mjs'

const fixtureBody = JSON.stringify({ model: 'fixture-model', ticket: 'fixture-ticket', payload: '{}' })
const request = (url = subscriptionChatUrl) => new Request(url, {
  method: 'POST', body: fixtureBody, headers: {
    cookie: 'fixture-cookie', authorization: 'Bearer fixture-secret', 'x-mikka-subscription-fake': 'forged',
  },
})

test('a callback client can only reach the fixed internal path and cannot redirect', async () => {
  const binding = { subscriptionChat() { return Response.redirect('https://example.invalid', 307) } }
  assert.equal((await subscriptionChatRequest(request(subscriptionChatUrl + '?other=1'), binding)).status, 404)
  assert.equal((await subscriptionChatRequest(new Request(subscriptionChatUrl), binding)).status, 404)
  assert.equal((await subscriptionChatRequest(request(), undefined)).status, 503)
  const refused = await subscriptionChatRequest(request(), binding)
  assert.equal(refused.status, 502)
  assert.equal(refused.headers.get('location'), null)
})

test('the callback streams through a private Cloudflare RPC into the separate Business API host', async t => {
  const require = createRequire(import.meta.url)
  const { Miniflare, convertV4MiniflareOptions } = createRequire(realpathSync(require.resolve('wrangler/package.json')))('miniflare')
  const persistence = await mkdtemp(join(tmpdir(), 'subscription-chat-binding-'))
  t.after(() => rm(persistence, { recursive: true, force: true }))
  const bridge = (await readFile(new URL('./subscription-chat.mjs', import.meta.url), 'utf8')).replace(/^export /gm, '')
  const ingress = (await readFile(new URL('../api/ingress/request.mjs', import.meta.url), 'utf8')).split('\n').slice(2).join('\n').replace(/^export /gm, '')
  const base = { modules: true, compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'] }
  const runtime = new Miniflare(convertV4MiniflareOptions({
    cf: false, host: '127.0.0.1', port: 0, resourcePersistencePath: persistence,
    workers: [
      { ...base, name: 'litellm-outbound', script: bridge + `
        export default { fetch(request, env) { return subscriptionChatRequest(request, env.SUBSCRIPTION_API) } }`,
      serviceBindings: { SUBSCRIPTION_API: 'business-api' } },
      { ...base, name: 'business-api', script: `import { WorkerEntrypoint } from 'cloudflare:workers'
        ` + bridge + ingress + `
        export default class extends WorkerEntrypoint {
          fetch() { return new Response(null, { status: 404 }) }
          subscriptionChat(request) {
            return subscriptionChatToApi(request, 'https://app.example.test', async forwarded => new Response(
              new ReadableStream({ start(controller) {
                controller.enqueue(new TextEncoder().encode('data: first\\n\\n'))
                controller.enqueue(new TextEncoder().encode('data: [DONE]\\n\\n'))
                controller.close()
              } }), { headers: {
                'content-type': 'text/event-stream', 'x-fixture-body': await forwarded.text(),
                'x-fixture-path': new URL(forwarded.url).pathname,
                'x-fixture-authority': forwarded.headers.get('authorization') ?? 'none',
                'x-fixture-cookie': forwarded.headers.get('cookie') ?? 'none',
              } }))
          }
        }` },
    ],
  }))
  t.after(() => runtime.dispose())
  const outbound = await runtime.getWorker('litellm-outbound')
  const response = await outbound.fetch(request())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  assert.equal(response.headers.get('x-fixture-path'), subscriptionChatPath)
  assert.equal(response.headers.get('x-fixture-body'), fixtureBody)
  assert.equal(response.headers.get('x-fixture-authority'), 'none')
  assert.equal(response.headers.get('x-fixture-cookie'), 'none')
  assert.equal(await response.text(), 'data: first\n\ndata: [DONE]\n\n')
  const api = await runtime.getWorker('business-api')
  assert.equal((await api.fetch(request())).status, 404)
})
