import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eveWorldRequest } from '../runtime/world.mjs'

const capability = 'world-capability-fixture-token'
const authed = (path = 'https://world.internal/world/rpc', method = 'POST') =>
  new Request(path, { method, headers: { 'x-mikka-world-capability': capability, 'content-type': 'application/cbor' }, ...(method === 'POST' ? { body: 'x', duplex: 'half' } : {}) })

test('only world.internal method allowlist reaches the bound service', async () => {
  const binding = { fetch: () => new Response('bound') }
  assert.equal((await eveWorldRequest(new Request('https://world.internal/world/rpc', { method: 'POST' }), binding, capability)).status, 403)
  assert.equal((await eveWorldRequest(authed('https://evil.example/world/rpc'), binding, capability)).status, 404)
  assert.equal((await eveWorldRequest(authed('https://world.internal/world/unknown'), binding, capability)).status, 404)
  assert.equal((await eveWorldRequest(authed('https://world.internal/world/rpc', 'PUT'), binding, capability)).status, 404)
  assert.equal((await eveWorldRequest(authed('https://world.internal/world/rpc?x=1#f'), binding, capability)).status, 404)
  assert.equal((await eveWorldRequest(authed(), undefined, capability)).status, 503)
})

test('capability mismatch is refused before any binding call', async () => {
  let calls = 0
  const binding = { fetch: () => { calls++; return new Response('bound') } }
  for (const presented of ['', 'short', capability + 'x', 'with spaces!!' + capability]) {
    const request = new Request('https://world.internal/world/rpc', { method: 'POST', headers: { 'x-mikka-world-capability': presented }, body: 'x', duplex: 'half' })
    assert.equal((await eveWorldRequest(request, binding, capability)).status, 403)
  }
  assert.equal(calls, 0)
  const response = await eveWorldRequest(authed(), binding, capability)
  assert.equal(await response.text(), 'bound')
  assert.equal(calls, 1)
})
