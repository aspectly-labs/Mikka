import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { forwardableApiPath, normalizedRendererPath, RENDERER_CSP, RENDERER_URL, rendererAssetPath, safeAppNext } from './bundled-policy'
import { isTrustedFrame, navigationDecision, originOf, trustedIpcSender } from './security'
import { bundledProtocol, PROXIED_CSP, PROXIED_HTML_CSP } from './bundled-protocol'
import { SessionVault, type EncryptedStorage, type StoredSession } from './session-vault'
import { BundledAuth, sameUrlPath } from './bundled-auth'
import { notifyBundledSessionChange, type BundledSessionChange } from './bundled-session-change'
import { BundledLive } from './bundled-live'
import { startBundledLoopback } from './bundled-loopback'
import { BundledViewer, validViewerGrant } from './bundled-viewer'

const identity = { user: { id: '84c182d1-661c-461b-bca2-10410cb646d4', name: 'Desktop Test', email: 'desktop@example.invalid', image: null }, session: { id: 'public-session-id' } }
const secret = 'main-session-secret-0123456789'
const stored: StoredSession = { identity, token: secret }

function encryption(): EncryptedStorage {
  const key = randomBytes(32)
  return {
    available: async () => true,
    async encrypt(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]) },
    async decrypt(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8') },
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'mikka-bundled-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('custom origin is explicit; opaque, lookalike, embedded and resource frames are unprivileged', () => {
  assert.equal(originOf(RENDERER_URL), 'mikka://app')
  for (const url of ['mikka://app.evil/mikka', 'mikka://user@app/mikka', 'mikka://app:80/mikka', 'file:///mikka', 'data:text/html,x', 'mikka://app/mikka/api/artifacts/a/versions/1/frame', 'mikka://app/mikka/%61pi/artifacts/a/versions/1/frame', 'mikka://app/mikka/assets/app.js']) assert.equal(isTrustedFrame(url, RENDERER_URL), false, url)
  assert.equal(isTrustedFrame('mikka://app/mikka/en?issue=a', RENDERER_URL), true)
  assert.equal(trustedIpcSender({ url: RENDERER_URL, parent: {} }, RENDERER_URL), false)
  assert.equal(trustedIpcSender(null, RENDERER_URL), false)
  assert.equal(trustedIpcSender({ url: RENDERER_URL, parent: null }, RENDERER_URL), true)
  assert.equal(navigationDecision('https://app.aspectlylabs.com/mikka', RENDERER_URL), 'external')
  assert.equal(navigationDecision('javascript:alert(1)', RENDERER_URL), 'deny')
  assert.equal(navigationDecision('mikka://app/', RENDERER_URL), 'allow')
  assert.equal(isTrustedFrame('mikka://app/', RENDERER_URL), false)
})

test('path policy rejects traversal, encoded delimiters and absolute targets', () => {
  for (const path of ['/mikka/../secret', '/mikka/%2e%2e/secret', '/mikka/%252e%252e/secret', '/mikka/%2fapi/auth/token', '/mikka/a\\b', '//evil.test/api', '/mikka/a%00b']) assert.equal(normalizedRendererPath(path), null, path)
  // Decoded controls and whitespace: URL construction strips TAB/CR/LF, so `.%0A.` would become `..`.
  for (const encoded of ['%09', '%0A', '%0a', '%0D', '%00', '%20', '%7F', '%0D%0A']) {
    for (const path of [`/mikka/api/.${encoded}./x`, `/mikka/api/${encoded}../x`, `/mikka/api/..${encoded}/x`, `/mikka/api/x${encoded}`, `/mikka/api/.${encoded}./%41pi/x`, `/mikka/api/%E2%80%A4.${encoded}./x`]) assert.equal(normalizedRendererPath(path), null, path)
  }
  assert.equal(normalizedRendererPath('/mikka/api/%41b'), '/api/Ab')
  assert.equal(rendererAssetPath('/safe/root', '/mikka/assets/file.js'), '/safe/root/assets/file.js')
  assert.equal(normalizedRendererPath('/mikka'), '/')
  assert.equal(safeAppNext('//evil.test'), '/')
  assert.equal(safeAppNext('/\\evil.test'), '/')
})

test('the proxy forwards any API path to the account server only, and nothing else', async t => {
  const root = await fixture(t)
  const forwarded: string[] = []
  const serve = bundledProtocol(root, { request: async (path, init) => { forwarded.push(`${init?.method ?? 'GET'} ${path}`); return Response.json({ ok: true }) } })
  const trusted = (path: string, init: RequestInit = {}) => serve(Object.assign(new Request(`mikka://app${path}`, init), { initiatorOrigin: 'mikka://app' }))
  // No per-route list: the server authorizes the person, workspace and permission.
  for (const path of ['/mikka/api/settings/issue-states', '/mikka/api/workspaces/84c182d1-661c-461b-bca2-10410cb646d4/task-labels', '/mikka/api/integrations/mcp/x/check']) {
    assert.equal((await trusted(path, { method: path.endsWith('check') ? 'POST' : 'GET' })).status, 200, path)
  }
  assert.deepEqual(forwarded, ['GET /api/settings/issue-states', 'GET /api/workspaces/84c182d1-661c-461b-bca2-10410cb646d4/task-labels', 'POST /api/integrations/mcp/x/check'])
  forwarded.length = 0
  // Traversal, encoded separators, absolute and protocol-relative targets, and non-API paths never reach the server.
  for (const path of [
    '/mikka/api/../../etc/passwd', '/mikka/api/%2e%2e/admin', '/mikka/api%2fsecret', '/mikka/api/a%2fb', '/mikka/api/a%5cb', '/mikka/api/%252e%252e',
    '/mikka/api//evil.test/x', '/mikka/api/x/', '//evil.test/mikka/api/x', '/mikka/api/a\\b',
  ]) {
    const response = await trusted(path)
    assert.ok([400, 404].includes(response.status), `${path} -> ${response.status}`)
  }
  // Encoded controls that would decode to `.\n.` and be stripped into `..` by URL construction.
  for (const path of ['/mikka/api/.%0A./.%0A./steal-me', '/mikka/api/.%09./x', '/mikka/api/x/.%0D./y', '/mikka/api/.%00./x', '/mikka/api/.%0A%41./x', '/mikka/api/%2E%0A./x', '/mikka/api/.%0A./%0A/evil.test/x']) {
    const response = await trusted(path)
    assert.equal(response.status, 400, `${path} -> ${response.status}`)
  }
  for (const href of ['https://evil.test/mikka/api/x', 'mikka://evil/mikka/api/x']) assert.equal((await serve(new Request(href))).status, 403, href)
  // A path outside /mikka/api is a local asset, never a request: it is not forwarded.
  assert.equal((await trusted('/mikka/apiary')).status, 404)
  assert.equal((await trusted('/mikka/api/x', { method: 'OPTIONS' })).status, 405)
  assert.equal(forwarded.length, 0)
  assert.equal(forwardableApiPath('/api/x'), true)
  for (const path of ['/api/', '/api//x', '/apix', '/assets/x', `/api/${'a'.repeat(5000)}`]) assert.equal(forwardableApiPath(path), false, path)
})

test('a response that echoes a session credential never reaches the renderer', async t => {
  const root = await fixture(t)
  const token = 'tok_' + 'x'.repeat(40)
  const reports: string[] = []
  const chunks = ['{"session":{"id":"s","token":"tok_', 'x'.repeat(40), '"}}']
  const serve = bundledProtocol(root, {
    credentials: () => [token],
    request: async path => path === '/api/auth/get-session'
      ? new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close() } }), { headers: { 'content-type': 'application/json' } })
      : path === '/api/header'
        ? new Response('{}', { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename=${token}` } })
        : new Response('{"ok":true,"tok_":"a prefix alone is fine"}', { headers: { 'content-type': 'application/json' } }),
  }, failure => reports.push(`${failure.route} ${failure.code}`))
  const trusted = (path: string) => serve(Object.assign(new Request(`mikka://app/mikka${path}`), { initiatorOrigin: 'mikka://app' }))
  // Split across chunks, the token is still caught: the body is cut off before its last part leaves main.
  await assert.rejects((await trusted('/api/auth/get-session')).text())
  assert.equal((await trusted('/api/header')).status, 502)
  assert.equal(await (await trusted('/api/inbox')).text(), '{"ok":true,"tok_":"a prefix alone is fine"}')
  assert.deepEqual(reports, ['/api/auth/[...all] desktop_credential_withheld', 'unmatched desktop_credential_withheld'])
})

test('every proxied response is an opaque sandbox; only artifact HTML may run inline script', async t => {
  const root = await fixture(t)
  const types: Record<string, string | null> = { svg: 'image/svg+xml', xml: 'application/xml', xhtml: 'application/xhtml+xml', json: 'application/json', untyped: null, html: 'Text/HTML; charset=utf-8', pdf: 'application/pdf' }
  const serve = bundledProtocol(root, { request: async path => {
    const type = types[path.split('/').at(-1)!]
    return new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>parent.mikka</script></svg>', { headers: type ? { 'content-type': type, 'content-security-policy': "default-src *" } : { 'content-security-policy': "default-src *" } })
  } })
  for (const kind of Object.keys(types)) {
    const response = await serve(Object.assign(new Request(`${RENDERER_URL}/api/files/${kind}`), { initiatorOrigin: 'mikka://app' }))
    const csp = response.headers.get('content-security-policy')!
    assert.equal(csp, kind === 'html' ? PROXIED_HTML_CSP : PROXIED_CSP, kind)
    assert.match(csp, /^sandbox(;| allow-scripts;)/, kind)
    if (kind !== 'html') assert.doesNotMatch(csp, /allow-scripts|script-src/, kind)
  }
})

test('renderer CSP has no remote code, eval, inline scripts, external fetch, workers or object', () => {
  assert.match(RENDERER_CSP, /script-src 'self';/)
  assert.doesNotMatch(RENDERER_CSP, /unsafe-eval|script-src[^;]*unsafe-inline/)
  assert.match(RENDERER_CSP, /connect-src 'self';/)
  assert.match(RENDERER_CSP, /object-src 'none'/)
  assert.match(RENDERER_CSP, /worker-src 'none'/)
})

test('local entry/assets load without backend; missing assets and symlink escape fail closed', async t => {
  const root = await fixture(t)
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<main>local</main>')
  await writeFile(join(root, 'assets', 'app.js'), 'export{}')
  const outside = join(root, '..', `${root.split('/').at(-1)}-outside`)
  await writeFile(outside, 'private')
  t.after(() => rm(outside, { force: true }))
  await symlink(outside, join(root, 'assets', 'escape.js'))
  const serve = bundledProtocol(root, { request: async () => { throw new Error('Backend must not be contacted') } })
  assert.equal(await (await serve(new Request(`${RENDERER_URL}/en?issue=a`))).text(), '<main>local</main>')
  assert.equal((await serve(new Request(`${RENDERER_URL}/assets/app.js`))).headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.equal((await serve(new Request(`${RENDERER_URL}/assets/missing.js`))).status, 404)
  assert.equal((await serve(new Request(`${RENDERER_URL}/assets/escape.js`))).status, 403)
  const redirect = await serve(new Request('mikka://app/?workspace=choice'))
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get('location'), `${RENDERER_URL}?workspace=choice`)
})

test('proxy strips credentials, cookies, redirects and remote policy; preserves streaming resume headers', async t => {
  const root = await fixture(t)
  let calls = 0
  const serve = bundledProtocol(root, { request: async (path, init) => {
    calls++
    assert.equal(path, '/api/agents/eve/v1/session/wrun_native/stream?startIndex=1')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('authorization'), null)
    assert.equal(headers.get('cookie'), null)
    assert.equal(headers.get('x-mikka-stream-key'), null)
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')); controller.close() } })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'set-cookie': `session_token=${secret}`, authorization: secret, 'x-mikka-session-token': secret, 'content-security-policy': "default-src * 'unsafe-eval'", 'x-eve-stream-format': 'ndjson', 'x-eve-stream-version': '27', 'x-eve-stream-tail-index': '1' } })
  } })
  const response = await serve(Object.assign(new Request(`${RENDERER_URL}/api/agents/eve/v1/session/wrun_native/stream?startIndex=1`, { headers: { authorization: 'Bearer malicious', cookie: 'session_token=malicious', 'x-mikka-stream-key': 'opaque-replay-cursor' } }), { initiatorOrigin: 'mikka://app' }))
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(response.headers.get('authorization'), null)
  assert.equal(response.headers.get('x-mikka-session-token'), null)
  assert.equal(response.headers.get('x-eve-stream-version'), '27')
  assert.equal(response.headers.get('content-security-policy'), PROXIED_CSP)
  assert.match(await response.text(), /data: first/)
  for (const request of [new Request(`${RENDERER_URL}/api/desktop/rpc`, { method: 'POST', headers: { origin: 'https://evil.test' } }), new Request(`${RENDERER_URL}/api/desktop/rpc`, { method: 'POST', headers: { origin: 'null' } }), new Request(`${RENDERER_URL}/api/workspace`, { headers: { 'sec-fetch-site': 'cross-site' } })]) assert.equal((await serve(request)).status, 403)
  // Electron removes Origin:null before dispatch, but retains this trusted
  // browser-provided field even for GETs that have no Origin or fetch metadata.
  for (const initiatorOrigin of ['null', 'https://evil.test', 'mikka://app.evil']) {
    const request = Object.assign(new Request(`${RENDERER_URL}/api/workspace`), { initiatorOrigin })
    assert.equal((await serve(request)).status, 403)
  }
  assert.equal(calls, 1)
})

test('OS-encrypted vault round trips, rejects wrong server/corruption and never writes plaintext', async t => {
  const directory = await fixture(t)
  const crypto = encryption()
  const vault = new SessionVault(directory, 'https://server.test/mikka', crypto)
  await vault.save(stored)
  const ciphertext = await readFile(join(directory, 'desktop-session.bin'))
  assert.equal(ciphertext.includes(secret), false)
  assert.equal(ciphertext.includes(identity.user.email), false)
  assert.deepEqual(await vault.load(), stored)
  assert.equal((await stat(join(directory, 'desktop-session.bin'))).mode & 0o777, 0o600)
  assert.equal(await new SessionVault(directory, 'https://other.test/mikka', crypto).load(), null)
  await writeFile(join(directory, 'desktop-session.bin'), 'corrupted')
  assert.equal(await vault.load(), null)
  await vault.save(null)
  assert.equal(await vault.load(), null)
})

test('unavailable OS keychain fails closed instead of persisting a plaintext session', async t => {
  const directory = await fixture(t)
  let encryptCalled = false
  const vault = new SessionVault(directory, 'https://server.test/mikka', { available: async () => false, encrypt: async () => { encryptCalled = true; return Buffer.from(secret) }, decrypt: async () => secret })
  await assert.rejects(vault.save(stored), /Secure session storage unavailable/)
  assert.equal(encryptCalled, false)
  assert.equal(await vault.load(), null)
})

test('main bearer never appears in public session and only validated workspace selector persists', async t => {
  const directory = await fixture(t)
  const vault = new SessionVault(directory, 'https://server.test/mikka', encryption())
  await vault.save(stored)
  const workspace = '29cd2c26-64cc-4e04-9339-a29610234ffe'
  let calls = 0; let changes = 0
  const auth = new BundledAuth({ serverUrl: 'https://server.test/mikka', version: '0.1.2', vault, openExternal: async () => {}, changed: () => { changes++ }, returned: () => {}, fetch: async (url, init) => {
    // The 401 is re-checked against the session endpoint, which agrees the session is gone.
    if (url === 'https://server.test/mikka/api/auth/get-session?disableCookieCache=true') return new Response(null, { status: 401 })
    assert.equal(url, 'https://server.test/mikka/api/desktop/rpc')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('authorization'), `Bearer ${secret}`)
    assert.equal(headers.get('cookie'), calls === 0 ? null : `mikka-workspace=${workspace}`)
    assert.equal(headers.get('x-mikka-api-version'), '1')
    assert.equal(init?.redirect, 'error')
    calls++
    return calls === 3 ? new Response(null, { status: 401 }) : new Response('{}', { headers: { 'set-cookie': `session_token=never-retain; Path=/, mikka-workspace=${workspace}; Path=/` } })
  } })
  await auth.restore()
  assert.deepEqual(auth.session(), identity)
  assert.equal(JSON.stringify(auth.session()).includes(secret), false)
  await auth.request('/api/desktop/rpc', { headers: { cookie: 'evil=1', authorization: 'Bearer injected' } })
  await auth.request('/api/desktop/rpc')
  assert.equal((await vault.load())?.workspace, workspace)
  await auth.request('/api/desktop/rpc')
  assert.equal(auth.session(), null)
  assert.equal(await vault.load(), null)
  assert.equal(changes, 1)
})

test('a 401 from one route keeps the session when the session endpoint still knows it', async t => {
  const vault = new SessionVault(await fixture(t), 'https://server.test/mikka', encryption())
  await vault.save(stored)
  const calls: string[] = []
  let switcher = 0, sessionReply: () => Response = () => Response.json({ user: identity.user, session: identity.session })
  let changes = 0
  const auth = new BundledAuth({ serverUrl: 'https://server.test/mikka', version: '0.1.2', vault, openExternal: async () => {}, changed: () => { changes++ }, returned: () => {}, fetch: async url => {
    const path = new URL(url).pathname.replace('/mikka', '') + new URL(url).search
    calls.push(path)
    if (path === '/api/auth/get-session?disableCookieCache=true') return sessionReply()
    if (path === '/api/workspace/switcher') return ++switcher === 1 ? new Response(null, { status: 401 }) : Response.json({ workspaces: [] })
    // The server's own mark is never believed: only main sets it.
    if (path === '/api/desktop/rpc') return Response.json({ version: 1, ok: false, error: { code: 'desktop_session_expired' } }, { status: 401, headers: { 'x-mikka-session-active': '1' } })
    return new Response(null, { status: 404 })
  } })
  await auth.restore()
  // A transient refusal: the session is still valid, so nobody is signed out and the read is asked again.
  const read = await auth.request('/api/workspace/switcher')
  assert.equal(read.status, 200)
  assert.deepEqual(auth.session(), identity)
  assert.equal(changes, 0)
  assert.deepEqual(calls, ['/api/workspace/switcher', '/api/auth/get-session?disableCookieCache=true', '/api/workspace/switcher'])
  // A write's 401 goes back to its caller without being repeated, with its
  // status and body, marked as a refusal the renderer must not read as expiry.
  calls.length = 0
  const refused = await auth.request('/api/desktop/rpc', { method: 'POST', body: '{}' })
  assert.equal(refused.status, 401)
  assert.equal(refused.headers.get('x-mikka-session-active'), '1')
  assert.deepEqual(await refused.json(), { version: 1, ok: false, error: { code: 'desktop_session_expired' } })
  assert.deepEqual(calls, ['/api/desktop/rpc', '/api/auth/get-session?disableCookieCache=true'])
  assert.deepEqual(auth.session(), identity)
  // No verdict (unreachable, a 5xx, a 403, a body that is not JSON) neither
  // signs out nor vouches for the session: the 401 goes back unmarked.
  for (const reply of [
    () => { throw new TypeError('fetch failed') },
    () => new Response(null, { status: 503 }),
    () => new Response(null, { status: 403 }),
    () => new Response('not json', { status: 200 }),
  ]) {
    sessionReply = reply
    assert.equal((await auth.request('/api/desktop/rpc', { method: 'POST', body: '{}' })).headers.has('x-mikka-session-active'), false)
    assert.deepEqual(auth.session(), identity)
  }
  assert.equal(changes, 0)
  // Concurrent 401s ask once; the session endpoint saying "no session" signs
  // out, and those 401s carry no mark, so the renderer sees the expiry.
  sessionReply = () => Response.json(null)
  calls.length = 0
  const expired = await Promise.all([auth.request('/api/desktop/rpc', { method: 'POST', body: '{}' }), auth.request('/api/desktop/rpc', { method: 'POST', body: '{}' })])
  for (const response of expired) assert.equal(response.headers.has('x-mikka-session-active'), false)
  assert.equal(calls.filter(path => path.startsWith('/api/auth/get-session')).length, 1)
  assert.equal(auth.session(), null)
  assert.equal(await vault.load(), null)
  assert.equal(changes, 1)
})

test('the protocol hands main\'s refused-operation mark to the renderer with the 401', async () => {
  const serve = bundledProtocol('/unused', { request: async () => Response.json({ version: 1, ok: false, error: { code: 'unauthorized' } }, { status: 401, headers: { 'x-mikka-session-active': '1' } }) })
  const response = await serve(new Request(`${RENDERER_URL}/api/desktop/rpc`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }))
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('x-mikka-session-active'), '1')
})

test('a 403 from the session endpoint is a refusal, not a sign-out', async t => {
  const vault = new SessionVault(await fixture(t), 'https://server.test/mikka', encryption())
  await vault.save(stored)
  let changes = 0
  let session = () => new Response(null, { status: 403 })
  const auth = new BundledAuth({ serverUrl: 'https://server.test/mikka', version: '0.1.2', vault, openExternal: async () => {}, changed: () => { changes++ }, returned: () => {}, fetch: async url => {
    if (new URL(url).pathname === '/mikka/api/auth/get-session') return session()
    return new Response(null, { status: 401 })
  } })
  await auth.restore()
  await auth.request('/api/desktop/rpc', { method: 'POST', body: '{}' })
  assert.deepEqual(auth.session(), identity)
  assert.equal(changes, 0)
  // Only a 401, a null session or another user signs out.
  session = () => Response.json({ user: { ...identity.user, id: '22222222-2222-4222-8222-222222222222' }, session: { id: 'other' } })
  await auth.request('/api/desktop/rpc', { method: 'POST', body: '{}' })
  assert.equal(auth.session(), null)
  assert.equal(changes, 1)
})

test('main sends only the checked path under the account server, including a base path', async t => {
  for (const server of ['https://corp.example.test/mikka', 'https://api.example.test/']) {
    await t.test(server, async t => {
      const vault = new SessionVault(await fixture(t), server, encryption())
      await vault.save({ ...stored, workspace: 'ws1' })
      const sent: string[] = []
      const auth = new BundledAuth({ serverUrl: server, version: '0.1.2', vault, openExternal: async () => {}, changed: () => {}, returned: () => {}, fetch: async (url, init = {}) => {
        sent.push(`${init.method ?? 'GET'} ${url}`)
        return Response.json({ ok: true })
      } })
      await auth.restore()
      const base = server.replace(/\/$/, '')
      const serve = bundledProtocol(await fixture(t), auth)
      const trusted = (path: string) => serve(Object.assign(new Request(`mikka://app${path}`), { initiatorOrigin: 'mikka://app' }))
      // The reviewer's escape: `.%0A.` decodes to `.\n.`, which URL construction turns into `..`.
      for (const path of [
        '/mikka/api/.%0A./.%0A./steal-me', '/mikka/api/.%0A./.%0A./other-app/admin', '/mikka/api/.%09./.%09./other-app/x?y=1',
        '/mikka/api/x/.%0D./.%0D./y', '/mikka/api/.%00./x', '/mikka/api/.%0D%0A./x', '/mikka/api/%2E%0A./x', '/mikka/api/x%0D%0AHost:%20evil.test',
      ]) {
        const response = await trusted(path)
        assert.ok([400, 403].includes(response.status), `${path} -> ${response.status}`)
      }
      assert.deepEqual(sent, [])
      // Main's own primitive refuses the same paths, and dot segments, before any request.
      for (const path of ['/api/.\n./.\n./steal-me', '/api/.\t./x', '/api/x/../../y', '/api/./x', '/api/x\r', '/api/x?a=\n']) await assert.rejects(auth.request(path), /Invalid backend path/, JSON.stringify(path))
      assert.deepEqual(sent, [])
      // Ordinary paths, encoded characters and non-ASCII still reach exactly the account server.
      for (const path of ['/mikka/api/workspace', '/mikka/api/agents/%E4%B8%AD%E6%96%87', '/mikka/api/x?q=a%20b']) assert.equal((await trusted(path)).status, 200, path)
      assert.deepEqual(sent, [`GET ${base}/api/workspace`, `GET ${base}/api/agents/%E4%B8%AD%E6%96%87`, `GET ${base}/api/x?q=a%20b`])
    })
  }
})

test('URL path comparison allows only the percent-encoding URL serialization adds', () => {
  assert.equal(sameUrlPath(new URL('https://x/mikka/api/a"b{c}').pathname, '/mikka/api/a"b{c}'), true)
  assert.equal(sameUrlPath(new URL('https://x/api/中😀').pathname, '/api/中😀'), true)
  assert.equal(sameUrlPath(new URL('https://x/api/a^b').pathname, '/api/a^b'), true)
  assert.equal(sameUrlPath('/api/a%5Eb', '/api/a^b'), true)
  assert.equal(sameUrlPath(new URL('https://x/mikka/api/.\n./.\n./x').pathname, '/mikka/api/.\n./.\n./x'), false)
  assert.equal(sameUrlPath('/x', '/mikka/api/../../x'), false)
  assert.equal(sameUrlPath('/api/x', '/api/\ud800'), false)
})

test('loopback validates nonce/code exactly, ignores wrong attempts and accepts once on localhost', async t => {
  const state = randomBytes(32).toString('base64url')
  const code = randomBytes(32).toString('base64url')
  const received: string[] = []
  const listener = await startBundledLoopback(state, value => received.push(value))
  t.after(() => listener.close())
  assert.equal(new URL(listener.callback).hostname, '127.0.0.1')
  assert.equal((await fetch(`${listener.callback}?state=${'x'.repeat(state.length)}&code=${code}`)).status, 400)
  assert.equal((await fetch(`${listener.callback}?state=${encodeURIComponent('é'.repeat(state.length))}&code=${code}`)).status, 400)
  assert.equal((await fetch(`${listener.callback}?state=${state}&state=${state}&code=${code}`)).status, 400)
  const response = await fetch(`${listener.callback}?state=${state}&code=${code}`)
  assert.equal(response.status, 200)
  assert.equal((await response.text()).includes(code), false)
  assert.deepEqual(received, [code])
  await assert.rejects(fetch(`${listener.callback}?state=${state}&code=${code}`))
})

test('browser handoff creates/exchanges PKCE only in main and publishes only public identity', { timeout: 5000 }, async t => {
  const vault = new SessionVault(await fixture(t), 'https://server.test/mikka', encryption())
  const sessionCache = Buffer.from('private-existing-signed-session-cache').toString('base64url')
  let registration: { state: string; callback: string; challenge: string } | undefined
  let opened: URL | undefined
  let complete!: () => void
  const finished = new Promise<void>(resolve => { complete = resolve })
  const code = randomBytes(32).toString('base64url')
  let bootstrapReads = 0, otherNotifications = 0
  const reads: Promise<Response>[] = []
  const bootstrap = () => auth.request('/api/desktop/rpc', { method: 'POST', body: JSON.stringify({ version: 1, action: 'desktop.bootstrap', args: [] }) })
  // An existing renderer reacts to sessionChanged by starting its ordinary
  // authenticated read; loadURL mounts another document with its own read.
  const main = { isDestroyed: () => false, getURL: () => RENDERER_URL, send: () => { reads.push(bootstrap()) } }
  const other = { ...main, send: () => { otherNotifications++ } }
  const auth = new BundledAuth({ serverUrl: 'https://server.test/mikka', version: '0.1.2', vault,
    openExternal: async url => { opened = new URL(url) },
    changed: (change?: BundledSessionChange) => notifyBundledSessionChange([main, other], main, RENDERER_URL, change),
    returned: async next => { assert.equal(next, '/en?issue=42'); reads.push(bootstrap()); await Promise.all(reads); complete() },
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body))
      if (url.endsWith('/api/desktop/rpc')) {
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`)
        assert.equal(body.action, 'desktop.bootstrap')
        bootstrapReads++
        return Response.json({ version: 1, ok: true, result: identity })
      }
      assert.equal(new Headers(init?.headers).get('authorization'), null)
      if (url.endsWith('/api/desktop/begin')) { registration = body; return new Response(null, { status: 204 }) }
      assert.ok(url.endsWith('/api/desktop/exchange'))
      assert.equal(body.client, 'bundled')
      assert.equal(body.code, code)
      assert.equal(body.state, registration?.state)
      assert.equal(createHash('sha256').update(body.verifier).digest('base64url'), registration?.challenge)
      return Response.json({ ...identity, token: secret }, { headers: { 'x-mikka-session-cache': sessionCache } })
    },
  })
  t.after(() => auth.dispose())
  await auth.signIn({ provider: 'github', locale: 'en', next: '/en?issue=42' })
  assert.ok(registration)
  assert.equal(opened?.pathname, '/mikka/en/sign-in')
  assert.equal(opened?.searchParams.get('continue'), 'github')
  assert.equal(opened?.searchParams.has('verifier'), false)
  assert.equal(opened?.searchParams.has('code'), false)
  assert.equal(auth.session(), null)
  await fetch(`${registration.callback}?state=${registration.state}&code=${code}`)
  await finished
  assert.equal(bootstrapReads, 1, 'PKCE navigation must not also bootstrap the old main document')
  assert.equal(otherNotifications, 1, 'other trusted windows still discard their old session')
  assert.deepEqual(auth.session(), identity)
  assert.equal((await vault.load())?.token, secret)
  assert.equal((await vault.load())?.sessionCache, sessionCache)
  assert.equal(JSON.stringify(auth.session()).includes(secret), false)
})

test('pending PKCE skips only the navigating main window and ordinary changes still notify it', () => {
  const notified: string[] = []
  const target = (id: string, url = RENDERER_URL, destroyed = false) => ({
    isDestroyed: () => destroyed, getURL: () => url, send: () => { notified.push(id) },
  })
  const main = target('main'), settings = target('settings', `${RENDERER_URL}/settings`)
  const contents = [main, settings, target('destroyed', RENDERER_URL, true), target('untrusted', 'https://other.invalid/')]
  notifyBundledSessionChange(contents, main, RENDERER_URL, { pendingReturn: true })
  assert.deepEqual(notified, ['settings'])
  notified.length = 0
  notifyBundledSessionChange(contents, main, RENDERER_URL)
  assert.deepEqual(notified, ['main', 'settings'])
  notified.length = 0
  notifyBundledSessionChange(contents, null, RENDERER_URL, { pendingReturn: true })
  assert.deepEqual(notified, ['main', 'settings'], 'without a navigating main no trusted window is suppressed')
})

test('PKCE navigation failure restores notification only for its current authentication generation', { timeout: 5000 }, async t => {
  for (const superseded of [false, true]) await t.test(superseded ? 'signed out during navigation' : 'current sign-in', async t => {
    const vault = new SessionVault(await fixture(t), 'https://server.test/mikka', encryption())
    let registration: { state: string; callback: string } | undefined
    let returned!: () => void, restored!: () => void, rejectNavigation!: (error: Error) => void
    const navigating = new Promise<void>(resolve => { returned = resolve })
    const recovered = new Promise<void>(resolve => { restored = resolve })
    const navigation = new Promise<void>((_resolve, reject) => { rejectNavigation = reject })
    const changes: (BundledSessionChange | undefined)[] = []
    const auth = new BundledAuth({ serverUrl: 'https://server.test/mikka', version: '0.1.2', vault,
      openExternal: async () => {},
      changed: change => { changes.push(change); if (!change) restored() },
      returned: () => { returned(); return navigation },
      fetch: async (url, init) => {
        if (url.endsWith('/api/desktop/begin')) { registration = JSON.parse(String(init?.body)); return new Response(null, { status: 204 }) }
        if (url.endsWith('/api/auth/sign-out')) return new Response(null, { status: 204 })
        assert.ok(url.endsWith('/api/desktop/exchange'))
        return Response.json({ ...identity, token: secret })
      },
    })
    t.after(() => auth.dispose())
    await auth.signIn({ provider: 'github', locale: 'en', next: '/' })
    assert.ok(registration)
    await fetch(`${registration.callback}?state=${registration.state}&code=${randomBytes(32).toString('base64url')}`)
    await navigating
    assert.deepEqual(changes, [{ pendingReturn: true }])
    if (superseded) await auth.signOut()
    rejectNavigation(new Error('fixture navigation failed'))
    if (!superseded) await recovered
    await nextTurn()
    assert.deepEqual(changes, [{ pendingReturn: true }, undefined], superseded ? 'the stale failure cannot notify after the later sign-out' : 'failed navigation refreshes the retained document')
    assert.deepEqual(auth.session(), superseded ? null : identity)
  })
})

test('password session rotation is accepted only for its RPC and refreshes public session id privately', async t => {
  const vault = new SessionVault(await fixture(t), 'https://server.test/mikka', encryption())
  await vault.save(stored)
  const replacement = 'rotated-main-secret-0123456789'
  let fresh = 0; let changed = 0
  const auth = new BundledAuth({ serverUrl: 'https://server.test/mikka', version: '0.1.2', vault,
    openExternal: async () => {}, returned: () => {}, changed: () => { changed++ }, fetch: async (url, init) => {
      if (url.endsWith('/api/auth/get-session')) {
        fresh++
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${replacement}`)
        return Response.json({ ...identity, session: { id: 'new-public-session-id', token: replacement } })
      }
      return Response.json({}, { headers: { 'x-mikka-session-token': replacement } })
    },
  })
  await auth.restore()
  await auth.request('/api/desktop/rpc', { method: 'POST', body: JSON.stringify({ version: 1, action: 'desktop.bootstrap', args: [] }) })
  assert.equal((await vault.load())?.token, secret)
  assert.equal(fresh, 0)
  await auth.request('/api/desktop/rpc', { method: 'POST', body: new TextEncoder().encode(JSON.stringify({ version: 1, action: 'account.changePassword', args: [] })) })
  assert.equal((await vault.load())?.token, replacement)
  assert.equal(auth.session()?.session.id, 'new-public-session-id')
  assert.equal(JSON.stringify(auth.session()).includes(replacement), false)
  assert.equal(fresh, 1)
  assert.equal(changed, 1)
})

test('saved-account switching uses that account bearer, safely projects choices and fences stale responses', async t => {
  const vault = new SessionVault(await fixture(t), 'https://server.test/mikka', encryption())
  const second = { token: 'second-private-session-0123456789', identity: { user: { ...identity.user, id: '29cd2c26-64cc-4e04-9339-a29610234ffe', email: 'second@example.invalid' }, session: { id: 'second-public-session' } } }
  const workspace = '096db4ab-6bf3-4bcc-ad4b-dcfc521bb007'
  await vault.saveAccounts({ activeUserId: identity.user.id, accounts: [stored, second] })
  let finishStale!: (response: Response) => void
  const stale = new Promise<Response>(resolve => { finishStale = resolve })
  const revoked: string[] = []
  let changed = 0
  const auth = new BundledAuth({ serverUrl: 'https://server.test/mikka', version: '0.1.2', vault, openExternal: async () => {}, returned: () => {}, changed: () => { changed++ }, fetch: async (url, init) => {
    const token = new Headers(init?.headers).get('authorization')
    if (url.endsWith('/api/coordinator/messages')) return stale
    if (url.endsWith('/api/auth/sign-out')) { revoked.push(token ?? ''); return Response.json({ success: true }) }
    if (url.endsWith('/api/workspace/switcher')) {
      const owner = token === `Bearer ${second.token}` ? second.identity : identity
      return Response.json({ workspace: { id: workspace }, live: {}, accounts: [{ id: owner.user.id, email: owner.user.email, token: 'must-not-cross-projection', choices: [{ id: workspace, name: 'Owned workspace', kind: 'team', secret: 'must-not-cross-projection' }] }] })
    }
    assert.equal(token, `Bearer ${second.token}`)
    return Response.json({ version: 1, ok: true, result: { ok: true, data: { workspaceId: workspace } } }, { headers: { 'set-cookie': `mikka-workspace=${workspace}; Path=/` } })
  } })
  await auth.restore()
  const staleRequest = auth.request('/api/coordinator/messages')
  const response = await auth.request('/api/desktop/rpc', { method: 'POST', body: new TextEncoder().encode(JSON.stringify({ version: 1, action: 'workspace.switchWorkspace', args: [{ accountId: second.identity.user.id, workspaceId: workspace }] })).buffer })
  assert.equal(response.status, 200)
  assert.equal(auth.session()?.user.id, second.identity.user.id)
  finishStale(new Response(null, { status: 401 }))
  assert.equal((await staleRequest).status, 409)
  assert.equal(auth.session()?.user.id, second.identity.user.id)
  const switcher = await (await auth.request('/api/workspace/switcher')).json() as { accounts: { id: string }[] }
  assert.deepEqual(switcher.accounts.map(item => item.id), [second.identity.user.id, identity.user.id])
  assert.equal(JSON.stringify(switcher).includes('must-not-cross-projection'), false)
  assert.equal(JSON.stringify(switcher).includes(second.token), false)
  assert.equal((await vault.loadAccounts())?.accounts.length, 2)
  assert.equal((await vault.load())?.workspace, workspace)
  await auth.signOut()
  assert.equal(await vault.loadAccounts(), null)
  assert.equal(auth.session(), null)
  assert.deepEqual(revoked.sort(), [`Bearer ${secret}`, `Bearer ${second.token}`].sort())
  assert.equal(changed, 2)
})

test('live hands renderer only owner-bound handles and refuses cross-window use or arbitrary messages', async () => {
  const live = new BundledLive({ session: () => identity, request: async () => Response.json({ url: `wss://gateway.test/v1/live/${'a'.repeat(64)}/socket`, protocol: 'private-ticket', expiresAt: Date.now() + 60_000 }) }, () => {})
  const prepared = await live.prepare(1, identity.user.id)
  assert.ok(prepared)
  assert.deepEqual(Object.keys(prepared).sort(), ['expiresAt', 'id'])
  assert.equal(JSON.stringify(prepared).includes('private-ticket'), false)
  assert.throws(() => live.connect(2, prepared.id), /Untrusted live owner/)
  assert.throws(() => live.send(1, prepared.id, '{"command":"run"}'), /Invalid live message/)
  live.closeAll()
  assert.throws(() => live.connect(1, prepared.id), /Live handle expired/)
})

test('viewer grants permit only the backend E2B viewer gateways and bounded expiries', () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString()
  assert.ok(validViewerGrant({ url: 'wss://6080-test.e2b.app/vnc?token=payload.signature', expiresAt }))
  assert.ok(validViewerGrant({ url: `wss://6082-test.foxtrot-2.e2b.dev/agents/${identity.user.id}/viewer?token=payload.signature`, expiresAt }))
  for (const url of ['ws://6080-test.e2b.app/vnc?token=a.b', 'wss://127.0.0.1/vnc?token=a.b', 'wss://6080-test.e2b.app.evil.test/vnc?token=a.b', 'wss://6080-test.e2b.app/other?token=a.b', 'wss://user@6080-test.e2b.app/vnc?token=a.b', 'wss://6080-test.e2b.app/vnc?token=a.b&redirect=https://evil.test']) assert.equal(validViewerGrant({ url, expiresAt }), null, url)
  assert.equal(validViewerGrant({ url: 'wss://6080-test.e2b.app/vnc?token=a.b', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), null)
})

test('main binary viewer hides credentials, scopes ownership/workspace, and bounds send/receive data', async () => {
  let scope = 'session:workspace-one'
  const events: import('@mikka/protocol/bridge').BundledViewerEvent[] = []
  let closed = 0
  const socket = {
    binaryType: 'blob', readyState: 1, bufferedAmount: 0,
    onopen: null, onmessage: null, onclose: null, onerror: null,
    send(data: Uint8Array) { assert.ok(data.byteLength <= 1024 * 1024) }, close() { closed++ },
  } as unknown as WebSocket
  const broker = new BundledViewer({ scope: () => scope, request: async (path, init) => {
    assert.equal(path, `/api/bots/${identity.user.id}/computer/viewer`)
    assert.equal(init?.body, '{"mode":"view"}')
    return Response.json({ url: 'wss://6080-test.e2b.app/vnc?token=private.signature', expiresAt: new Date(Date.now() + 60_000).toISOString() })
  } }, (_owner, event) => events.push(event), url => { assert.match(url, /private\.signature/); return socket })
  const result = await broker.prepare(7, { botId: identity.user.id, mode: 'view' })
  assert.equal(result.status, 200)
  assert.equal(JSON.stringify(result).includes('private.signature'), false)
  assert.ok('url' in result.body)
  const id = new URL(result.body.url).pathname.slice(1)
  assert.equal(new URL(result.body.url).hostname, 'desktop-viewer.invalid')
  assert.throws(() => broker.connect(8, id), /Untrusted viewer owner/)
  broker.connect(7, id)
  socket.onopen?.call(socket, new Event('open'))
  socket.onmessage?.call(socket, new MessageEvent('message', { data: new Uint8Array([1, 2, 3]).buffer }))
  assert.deepEqual(events.at(-1)?.data, new Uint8Array([1, 2, 3]))
  broker.send(7, id, new Uint8Array([4, 5]))
  assert.throws(() => broker.send(7, id, new Uint8Array(1024 * 1024 + 1)), /Invalid viewer message/)
  assert.throws(() => broker.send(7, id, 'arbitrary text'), /Invalid viewer message/)
  scope = 'session:workspace-two'
  assert.throws(() => broker.send(7, id, new Uint8Array([6])), /Invalid viewer message/)
  assert.equal(closed, 1)
  assert.equal(events.at(-1)?.type, 'close')
  broker.closeAll()
})


test('desktop forwards eve protocol headers and fences NDJSON bytes at account/workspace changes', async t => {
  const root = await fixture(t)
  let scope = 'owner-a:workspace-a', cancelled = false
  let source!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller }, cancel() { cancelled = true } })
  const serve = bundledProtocol(root, { scope: () => scope, request: async (path, init) => {
    assert.equal(path, '/api/agents/eve/v1/session/wrun_bot/stream?botId=bot-a&startIndex=5')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('x-mikka-submission-id'), 'logical-operation')
    assert.equal(headers.get('cookie'), null)
    assert.equal(headers.get('authorization'), null)
    return new Response(stream, { headers: {
      'content-type': 'application/x-ndjson', 'x-eve-stream-format': 'ndjson', 'x-eve-stream-version': '27',
      'x-eve-stream-tail-index': '6', 'x-eve-session-id': 'wrun_bot', 'x-eve-observation-key': '["local","wrun_bot"]',
      'set-cookie': `session_token=${secret}`, 'x-mikka-session-token': secret,
    } })
  } })
  const response = await serve(new Request(`${RENDERER_URL}/api/agents/eve/v1/session/wrun_bot/stream?botId=bot-a&startIndex=5`, { headers: { 'x-mikka-submission-id': 'logical-operation', authorization: 'Bearer attacker', cookie: 'attacker' } }))
  for (const [header, expected] of Object.entries({ 'x-eve-stream-format': 'ndjson', 'x-eve-stream-version': '27', 'x-eve-stream-tail-index': '6', 'x-eve-session-id': 'wrun_bot', 'x-eve-observation-key': '["local","wrun_bot"]' })) assert.equal(response.headers.get(header), expected)
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(response.headers.get('x-mikka-session-token'), null)
  const reader = response.body!.getReader()
  source.enqueue(new TextEncoder().encode('{"first":true}\n'))
  assert.equal(new TextDecoder().decode((await reader.read()).value), '{"first":true}\n')
  scope = 'owner-b:workspace-b'
  source.enqueue(new TextEncoder().encode('{"previousOwner":true}\n'))
  assert.equal((await reader.read()).done, true)
  assert.equal(cancelled, true)
})

