import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { routeProbePlan, runRouteProbe } from './route-probe.mjs'
import { internalOnlyPath, internalOnlyRoutes } from '../../cloudflare/api/ingress/internal-only.mjs'

const manifest = routes => ({ version: 1, basePath: '/mikka', routes })
const route = (path = '/mikka/api/items/[id]', methods = ['GET', 'POST']) => ({ path, methods })
const healthy = probe => new Response(null, { status: probe.expectedStatus, headers: { allow: probe.allowed.join(', ') } })

test('all generated routes have a safe dispatch-only probe, including explicit OPTIONS and catch-all routes', async () => {
  const generated = JSON.parse(await readFile(new URL('../../apps/api/generated/routes.json', import.meta.url), 'utf8'))
  const plan = routeProbePlan(generated)
  assert.equal(plan.length, generated.routes.length)
  for (const [index, probe] of plan.entries()) {
    assert.equal(generated.routes[index].methods.includes(probe.method), false)
    assert.equal(/[[\]]/.test(probe.path), false)
    if (internalOnlyPath(probe.route)) assert.deepEqual([probe.expectedStatus, probe.internal, probe.allowed], [404, true, undefined])
    else assert.equal(probe.allowed.includes('OPTIONS'), true)
  }
  assert.ok(plan.some(probe => probe.method === 'PUT' && probe.expectedStatus === 405))
})

test('anonymous requests carry no body or credentials and do not follow redirects', async () => {
  const input = manifest([route(), route('/mikka/api/agents/[...path]', ['GET', 'OPTIONS', 'POST'])])
  const plan = routeProbePlan(input)
  const calls = []
  const report = await runRouteProbe({ baseUrl: 'https://stage.example.test/mikka', manifest: input, fetchImpl: async (url, init) => {
    calls.push({ url, init })
    const probe = plan.find(item => url.endsWith(item.path))
    assert.equal(init.method, probe.method)
    assert.equal(init.body, undefined)
    assert.equal(init.credentials, 'omit')
    assert.equal(init.redirect, 'manual')
    assert.deepEqual(init.headers, { accept: 'application/json' })
    assert.ok(init.signal instanceof AbortSignal)
    return healthy(probe)
  } })
  assert.equal(calls.length, 2)
  assert.equal(report.status, 'pass')
  assert.equal(report.passed, 2)
})

test('404, 5xx, redirects and a generic OPTIONS response without the real Allow contract fail', async () => {
  for (const status of [404, 500, 503, 302, 204]) {
    const report = await runRouteProbe({ baseUrl: 'https://stage.example.test', manifest: manifest([route()]),
      fetchImpl: async () => new Response(null, { status }) })
    assert.equal(report.status, 'fail')
    assert.equal(report.failed, 1)
    assert.equal(report.results[0].status, status)
  }
})

test('a changed route method list fails the dispatch contract even when its path exists', async () => {
  const report = await runRouteProbe({ baseUrl: 'https://stage.example.test', manifest: manifest([route()]),
    fetchImpl: async () => new Response(null, { status: 204, headers: { allow: 'GET, HEAD, OPTIONS' } }) })
  assert.equal(report.status, 'fail')
  assert.equal(report.results[0].error, 'route_probe_allow')
})

test('network failures preserve a closed cause and never expose response bodies or origins', async () => {
  const report = await runRouteProbe({ baseUrl: 'https://private.example.test', manifest: manifest([route()]),
    fetchImpl: async () => { throw new Error('https://private.example.test/?token=secret') } })
  assert.equal(report.status, 'fail')
  assert.equal(report.results[0].error, 'route_probe_request_failed')
  assert.doesNotMatch(JSON.stringify(report), /private\.example|secret/)
})

test('malformed inventories, unsafe origins and handlers implementing every method fail before any request', async () => {
  let called = false
  const fetchImpl = async () => { called = true; throw new Error('unexpected') }
  for (const baseUrl of [undefined, 'http://remote.example', 'https://user:password@example.test', 'https://example.test/private', 'https://example.test/?token=secret']) {
    await assert.rejects(runRouteProbe({ baseUrl, manifest: manifest([route()]), fetchImpl }), /route_probe_origin_invalid/)
  }
  for (const input of [manifest([]), manifest([route('/mikka/../api/write')]), manifest([route(), route()]), manifest([route('/mikka/api/full', ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])])]) {
    await assert.rejects(runRouteProbe({ baseUrl: 'http://127.0.0.1', manifest: input, fetchImpl }), /route_probe_/)
  }
  assert.equal(called, false)
})

const subscriptionChat = '/mikka/api/internal/subscription/chat'

test('a route the public edge keeps internal must answer 404 there; anything else fails as reachable', async () => {
  const generated = JSON.parse(await readFile(new URL('../../apps/api/generated/routes.json', import.meta.url), 'utf8'))
  assert.ok(generated.routes.some(item => item.path === subscriptionChat))
  const [probe] = routeProbePlan(manifest([route(subscriptionChat, ['POST'])]))
  assert.deepEqual(probe, { route: subscriptionChat, path: subscriptionChat, method: 'OPTIONS', expectedStatus: 404, internal: true })
  const closed = await runRouteProbe({ baseUrl: 'https://stage.example.test', manifest: manifest([route(subscriptionChat, ['POST'])]),
    fetchImpl: async () => new Response(null, { status: 404 }) })
  assert.deepEqual([closed.status, closed.passed, closed.results[0].status], ['pass', 1, 404])
  for (const status of [204, 200, 405, 401, 500, 302]) {
    const report = await runRouteProbe({ baseUrl: 'https://stage.example.test', manifest: manifest([route(subscriptionChat, ['POST'])]),
      fetchImpl: async () => new Response(null, { status, headers: { allow: 'OPTIONS, POST' } }) })
    assert.equal(report.status, 'fail')
    assert.equal(report.results[0].error, 'route_probe_internal_reachable')
  }
})

test('a normal route keeps its 204/405 + Allow expectation and still fails on 404', async () => {
  const plan = routeProbePlan(manifest([route(), route('/mikka/api/agents/[...path]', ['GET', 'OPTIONS', 'POST'])]))
  assert.deepEqual(plan.map(probe => [probe.method, probe.expectedStatus, probe.internal]), [['OPTIONS', 204, undefined], ['PUT', 405, undefined]])
  assert.deepEqual(plan[0].allowed, ['GET', 'HEAD', 'OPTIONS', 'POST'])
  const report = await runRouteProbe({ baseUrl: 'https://stage.example.test', manifest: manifest([route()]),
    fetchImpl: async () => new Response(null, { status: 404 }) })
  assert.equal(report.results[0].error, 'route_probe_status')
})

test('the probe and the public ingress worker agree on every internal-only route', async () => {
  // The probe must use the edge's own predicate, never a copy.
  const source = await readFile(new URL('./route-probe.mjs', import.meta.url), 'utf8')
  const worker = await readFile(new URL('../../cloudflare/api/ingress/worker.mjs', import.meta.url), 'utf8')
  for (const text of [source, worker]) {
    assert.match(text, /import \{ internalOnlyPath \} from '[./]+(?:cloudflare\/api\/ingress\/)?internal-only\.mjs'/)
    assert.doesNotMatch(text, /internal\/subscription\/chat|subscriptionChatPath/)
  }
  // apps/api/scripts/cloudflare-api.test.mjs runs this same probe against the real ingress worker.
  assert.deepEqual(internalOnlyRoutes, [subscriptionChat])
  for (const path of [subscriptionChat, subscriptionChat + '/', '/mikka/api/internal/%73ubscription/chat']) assert.equal(internalOnlyPath(path), true)
  for (const path of ['/mikka/api/internal/subscription', '/mikka/api/internal/subscription/chats', '/mikka/api/version']) assert.equal(internalOnlyPath(path), false)
})
