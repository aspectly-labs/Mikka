import assert from 'node:assert/strict'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { test, type TestContext } from 'node:test'
import { failedDeliveries, githubAppJwt, nextCursor, redeliverFailedGitHubWebhooks, type GitHubDelivery } from './github-redelivery'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString())
const officialCloud = { MIKKA_EDITION: 'cloud', MIKKA_CLOUD_BACKEND_URL: 'https://private.example.com' }

// Only translate the fixed private origin to loopback. HTTP, response streaming
// and AbortSignal cancellation use native fetch, not a mocked Response.
async function brokerFixture(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return (async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.href, 'https://github-redelivery.internal/redeliver')
    assert.equal(init?.method, 'POST')
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.credentials, 'omit')
    assert.equal(init?.cache, 'no-store')
    assert.ok(init?.signal instanceof AbortSignal)
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}`, init)
  }) as typeof fetch
}

test('official Cloud reads the real broker summary without loading App signing credentials in the API', async t => {
  const summary = { configured: true, scanned: 120, failed: 2, redelivered: 2, errors: 0 }
  let calls = 0
  const fetcher = await brokerFixture(t, (request, response) => {
    calls++
    assert.equal(request.url, '/redeliver')
    assert.equal(request.headers.authorization, undefined)
    assert.equal(request.headers.cookie, undefined)
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(summary))
  })
  assert.deepEqual(await redeliverFailedGitHubWebhooks({ env: officialCloud, fetcher }), summary)
  assert.equal(calls, 1)
  const withoutSigningAccess = { ...officialCloud, get GITHUB_APP_PRIVATE_KEY(): string { throw new Error('App signing configuration must remain private') } }
  assert.deepEqual(await redeliverFailedGitHubWebhooks({ env: withoutSigningAccess, fetcher }), summary)
  assert.equal(calls, 2)
})

test('Cloud without a webhook URL still uses the broker and never reads App signing credentials', async t => {
  const summary = { configured: true, scanned: 12, failed: 1, redelivered: 1, errors: 0 }
  let calls = 0
  const fetcher = await brokerFixture(t, (_request, response) => {
    calls++
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(summary))
  })
  const env = { MIKKA_EDITION: 'cloud', get GITHUB_APP_PRIVATE_KEY(): string { throw new Error('App signing configuration must remain private') } }
  assert.deepEqual(await redeliverFailedGitHubWebhooks({ env, fetcher }), summary)
  assert.equal(calls, 1)
})

test('the App JWT is RS256, issued by the App, and expires within 10 minutes', () => {
  const now = new Date('2026-10-27T08:00:00Z')
  // A key stored on one line with literal \n still signs.
  const token = githubAppJwt('4840908', privateKey.replace(/\n/g, '\\n'), now)
  const [header, claims, signature] = token.split('.')
  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' })
  const { iat, exp, iss } = decode(claims)
  assert.equal(iss, '4840908')
  assert.equal(iat, now.getTime() / 1000 - 60)
  assert.ok(exp > now.getTime() / 1000 && exp - iat <= 600)
  assert.equal(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url')), true)
})

const at = (minutesAgo: number) => new Date(Date.parse('2026-10-27T08:00:00Z') - minutesAgo * 60_000).toISOString()
const delivery = (id: number, guid: string, minutesAgo: number, status: number, event = 'pull_request'): GitHubDelivery => ({ id: String(id), guid, delivered_at: at(minutesAgo), redelivery: id > 100, status_code: status, event })

test('only failed suggestion deliveries in the window are redelivered, once per guid', () => {
  const since = new Date(at(180))
  const picked = failedDeliveries([
    delivery(1, 'a', 30, 503),
    delivery(2, 'b', 40, 503), delivery(102, 'b', 20, 202), // a redelivery already got through
    delivery(3, 'c', 50, 0), delivery(103, 'c', 10, 500), // timed out, then failed again: send the latest once
    delivery(4, 'd', 60, 200),
    delivery(5, 'e', 240, 503), // outside the window
    delivery(6, 'f', 30, 503, 'push'), // not an event that feeds suggestions
  ], since)
  assert.deepEqual(picked.map(item => item.id), ['1', '103'])
  assert.equal(failedDeliveries([delivery(1, 'a', 30, 503), delivery(2, 'b', 31, 503)], since, 1).length, 1)
})

test('reads the next page cursor from the Link header', () => {
  assert.equal(nextCursor('<https://api.github.com/app/hook/deliveries?per_page=100&cursor=v1_123>; rel="next"'), 'v1_123')
  assert.equal(nextCursor('<https://api.github.com/app/hook/deliveries?cursor=x>; rel="prev"'), null)
  assert.equal(nextCursor(null), null)
})

test('does nothing without the App credentials', async () => {
  let calls = 0
  const result = await redeliverFailedGitHubWebhooks({ env: { GITHUB_APP_ID: '4840908' }, fetcher: (async () => { calls++; return new Response('[]') }) as typeof fetch })
  assert.equal(result.configured, false)
  assert.equal(calls, 0)
})

test('redelivers each failed delivery through the attempts endpoint', async () => {
  const now = new Date('2026-10-27T08:00:00Z')
  const posted: string[] = []
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { posted.push(String(url)); return new Response(null, { status: 202 }) }
    return Response.json([delivery(7, 'g', 30, 503), delivery(8, 'h', 30, 200)])
  }) as typeof fetch
  const result = await redeliverFailedGitHubWebhooks({ now, env: { GITHUB_APP_ID: '4840908', GITHUB_APP_PRIVATE_KEY: privateKey }, fetcher })
  assert.deepEqual(posted, ['https://api.github.com/app/hook/deliveries/7/attempts'])
  assert.deepEqual(result, { configured: true, scanned: 2, failed: 1, redelivered: 1, errors: 0 })
})

test('preserves a raw 19-digit delivery ID in the redelivery URL', async () => {
  const now = new Date('2026-10-27T08:00:00Z')
  const posted: string[] = []
  const raw = '[{"id":3850587977317089288,"guid":"large-id","delivered_at":"2026-10-27T07:30:00Z","redelivery":false,"status_code":503,"event":"pull_request"}]'
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { posted.push(String(url)); return new Response(null, { status: 202 }) }
    return new Response(raw, { headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const result = await redeliverFailedGitHubWebhooks({ now, env: { GITHUB_APP_ID: '4840908', GITHUB_APP_PRIVATE_KEY: privateKey }, fetcher })
  assert.deepEqual(posted, ['https://api.github.com/app/hook/deliveries/3850587977317089288/attempts'])
  assert.deepEqual(result, { configured: true, scanned: 1, failed: 1, redelivered: 1, errors: 0 })
})

test('reads beyond ten pages for failures in the window and still redelivers at most 25', async () => {
  const now = new Date('2026-10-27T08:00:00Z')
  const posted: string[] = []
  const cursors: (string | null)[] = []
  const rawFailure = '{"id":3850587977317089288,"guid":"page-eleven","delivered_at":"2026-10-27T07:00:00Z","redelivery":false,"status_code":503,"event":"pull_request"}'
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { posted.push(String(url)); return new Response(null, { status: 202 }) }
    cursors.push(new URL(url).searchParams.get('cursor'))
    const page = cursors.length
    if (page <= 10) return Response.json([delivery(page, `succeeded-${page}`, page * 5, 202)], {
      headers: { link: `<https://api.github.com/app/hook/deliveries?cursor=page-${page + 1}>; rel="next"` },
    })
    assert.equal(page, 11)
    return new Response(`[${rawFailure},${Array.from({ length: 29 }, (_, index) => JSON.stringify(delivery(1000 + index, `failed-${index}`, 60, 503))).join(',')}]`)
  }) as typeof fetch
  const result = await redeliverFailedGitHubWebhooks({ now, env: { GITHUB_APP_ID: '4840908', GITHUB_APP_PRIVATE_KEY: privateKey }, fetcher })
  assert.deepEqual(cursors, [null, ...Array.from({ length: 10 }, (_, index) => `page-${index + 2}`)])
  assert.equal(posted[0], 'https://api.github.com/app/hook/deliveries/3850587977317089288/attempts')
  assert.equal(posted.length, 25)
  assert.deepEqual(result, { configured: true, scanned: 40, failed: 30, redelivered: 25, errors: 0 })
})

test('stops at the three-hour boundary even when the page has another cursor', async () => {
  const now = new Date('2026-10-27T08:00:00Z')
  let pages = 0
  const posted: string[] = []
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { posted.push(String(url)); return new Response(null, { status: 202 }) }
    pages++
    assert.equal(pages, 1)
    return Response.json([delivery(1, 'in-window', 180, 503), delivery(2, 'too-old', 181, 503)], {
      headers: { link: '<https://api.github.com/app/hook/deliveries?cursor=older>; rel="next"' },
    })
  }) as typeof fetch
  const result = await redeliverFailedGitHubWebhooks({ now, env: { GITHUB_APP_ID: '4840908', GITHUB_APP_PRIVATE_KEY: privateKey }, fetcher })
  assert.deepEqual(posted, ['https://api.github.com/app/hook/deliveries/1/attempts'])
  assert.deepEqual(result, { configured: true, scanned: 2, failed: 1, redelivered: 1, errors: 0 })
})

test('reports rejected redelivery attempts as errors', async () => {
  const now = new Date('2026-10-27T08:00:00Z')
  const fetcher = (async (_url: string | URL, init?: RequestInit) => init?.method === 'POST'
    ? new Response(null, { status: 500 })
    : Response.json([delivery(7, 'failed', 30, 503)])) as typeof fetch
  const result = await redeliverFailedGitHubWebhooks({ now, env: { GITHUB_APP_ID: '4840908', GITHUB_APP_PRIVATE_KEY: privateKey }, fetcher })
  assert.deepEqual(result, { configured: true, scanned: 1, failed: 1, redelivered: 0, errors: 1 })
})

test('rejects an incomplete delivery scan without posting redeliveries', async () => {
  const now = new Date('2026-10-27T08:00:00Z')
  let pages = 0
  const fetcher = (async (_url: string | URL, init?: RequestInit) => {
    assert.notEqual(init?.method, 'POST')
    if (++pages === 1) return Response.json([delivery(7, 'failed', 30, 503)], {
      headers: { link: '<https://api.github.com/app/hook/deliveries?cursor=next>; rel="next"' },
    })
    return new Response(null, { status: 403 })
  }) as typeof fetch
  await assert.rejects(redeliverFailedGitHubWebhooks({ now, env: { GITHUB_APP_ID: '4840908', GITHUB_APP_PRIVATE_KEY: privateKey }, fetcher }), /GitHub delivery log answered 403/)
  assert.equal(pages, 2)
})

test('official Cloud preserves partial failures and unconfigured results from the private broker', async t => {
  for (const [status, summary] of [
    [502, { configured: true, scanned: 17, failed: 3, redelivered: 2, errors: 1 }],
    [503, { configured: false, scanned: 0, failed: 0, redelivered: 0, errors: 0 }],
  ] as const) {
    const fetcher = await brokerFixture(t, (_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(summary))
    })
    assert.deepEqual(await redeliverFailedGitHubWebhooks({ env: officialCloud, fetcher }), summary)
  }
})

test('official Cloud rejects malformed, contradictory, oversized and unsuccessful broker responses', async t => {
  const summary = { configured: true, scanned: 17, failed: 3, redelivered: 2, errors: 1 }
  for (const [status, body] of [
    [502, '{}'], [503, JSON.stringify({ error: 'temporarily_unavailable', code: 'cloud_unavailable' })],
    [200, JSON.stringify(summary)], [503, JSON.stringify(summary)],
    [502, JSON.stringify({ ...summary, errors: 0 })], [502, JSON.stringify({ ...summary, errors: -1 })],
    [502, JSON.stringify({ ...summary, scanned: 10_001 })], [502, JSON.stringify({ ...summary, failed: 2 })],
    [502, JSON.stringify({ ...summary, extra: 'synthetic-private-detail' })],
    [502, '[' + ' '.repeat(1024) + ']'], [404, 'unavailable'],
  ] as const) {
    const fetcher = await brokerFixture(t, (_request, response) => { response.writeHead(status); response.end(body) })
    await assert.rejects(redeliverFailedGitHubWebhooks({ env: officialCloud, fetcher }), { code: 'cloud_unavailable' })
  }
})

test('official Cloud refuses redirects without making a second request', async t => {
  let calls = 0
  const fetcher = await brokerFixture(t, (_request, response) => {
    calls++; response.writeHead(302, { location: '/redirected' }); response.end()
  })
  await assert.rejects(redeliverFailedGitHubWebhooks({ env: officialCloud, fetcher }), { code: 'cloud_unavailable', detail: 'network' })
  assert.equal(calls, 1)
})

test('the 40-second broker budget and shorter caller deadline cancel real response bodies and close the connection', { timeout: 5000 }, async t => {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal)
  const durations: number[] = []
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    durations.push(ms)
    return nativeTimeout(ms > 1000 ? 100 : ms)
  })
  for (const callerBudget of [Infinity, 150]) {
    let closed!: () => void
    const connectionClosed = new Promise<void>(resolve => { closed = resolve })
    const fetcher = await brokerFixture(t, (_request, response) => {
      response.on('close', closed)
      response.writeHead(200, { 'content-type': 'application/json' }); response.write('{')
    })
    await assert.rejects(redeliverFailedGitHubWebhooks({ env: officialCloud, fetcher, deadline: Date.now() + callerBudget }), { code: 'cloud_unavailable' })
    await connectionClosed
  }
  assert.ok(durations[0] > 39_000 && durations[0] <= 40_000)
  assert.ok(durations[1] > 0 && durations[1] <= 150)
})

test('an expired caller deadline starts no broker request', async () => {
  let calls = 0
  await assert.rejects(redeliverFailedGitHubWebhooks({ env: officialCloud, deadline: Date.now() - 1,
    fetcher: async () => { calls++; throw new Error('unexpected fetch') },
  }), { code: 'cloud_unavailable' })
  assert.equal(calls, 0)
})
