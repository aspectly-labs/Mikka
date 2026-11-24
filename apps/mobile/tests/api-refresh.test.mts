import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { SavedAccount } from '../lib/server-store.ts'

// The app's real request path (lib/api.ts) and refresh wiring (lib/refresh.ts),
// with the keychain, the auth client and the network replaced.
const server = { url: 'https://cloud.example/mikka', name: 'Cloud', version: null, edition: 'cloud' as const, signIn: { email: true, google: false, github: false, apple: false }, mobileReady: true }
let current: SavedAccount = { id: '1', server, user: { id: 'u1', name: 'A', email: 'a@example.test' } }
const keychain = new Map<string, string>()
let cookie = 'better-auth.session_token=old'
let rotateAnswer: () => Promise<{ data: unknown; error: { status: number; code?: string } | null }> = async () => ({ data: null, error: { status: 503 } })
const authCalls: string[] = []
const client = {
  getCookie: async () => cookie,
  $fetch: async (path: string, init: { body?: Record<string, string> }) => {
    authCalls.push(path)
    if (path === '/mobile-refresh/rotate') return rotateAnswer()
    if (path === '/mobile-refresh/exchange') return { data: { userId: 'u1', sessionId: 's1', refreshToken: `mkmr_${'e'.repeat(43)}`, refreshExpiresAt: later(1440), accessExpiresAt: later(60) }, error: null }
    if (path === '/mobile-refresh/revoke') return { data: { status: !!init.body }, error: null }
    return { data: null, error: { status: 404 } }
  },
}
let refused = 0
mock.module('react-native', { namedExports: { Platform: { OS: 'ios' } } })
mock.module('expo-secure-store', { namedExports: {
  getItemAsync: async (key: string) => keychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { keychain.set(key, value) },
  deleteItemAsync: async (key: string) => { keychain.delete(key) },
} })
mock.module(new URL('../lib/auth.ts', import.meta.url).href, { namedExports: { authClient: client } })
mock.module(new URL('../lib/config.ts', import.meta.url).href, { namedExports: { currentAccount: () => current } })
mock.module(new URL('../lib/session.ts', import.meta.url).href, { namedExports: { endLostSession: async () => {}, sessionRefused: async () => { refused++ } } })
mock.module(new URL('../lib/tracing.ts', import.meta.url).href, { namedExports: { mobileTraceHeaders: () => ({ 'x-mikka-client-kind': 'mobile' }) } })
const { api } = await import('../lib/api.ts')
const { apiCache } = await import('../lib/api-cache.ts')
const { keepSignedIn } = await import('../lib/refresh.ts')
const { accountStorageKey } = await import('../lib/server-store.ts')

function later(minutes: number) { return new Date(Date.now() + minutes * 60_000).toISOString() }
function signedIn(account: string, accessMinutes = 60) {
  current = { id: account, server, user: { id: 'u1', name: 'A', email: 'a@example.test' } }
  apiCache.setIdentity(`${account}:u1`)
  cookie = 'better-auth.session_token=old'
  refused = 0; authCalls.length = 0
  keychain.set(accountStorageKey(account, 'refresh'), JSON.stringify({ userId: 'u1', sessionId: 's1', refreshToken: `mkmr_${'a'.repeat(43)}`, refreshExpiresAt: later(1440), accessExpiresAt: later(accessMinutes) }))
}
const renewed = { data: { userId: 'u1', sessionId: 's1', refreshToken: `mkmr_${'b'.repeat(43)}`, refreshExpiresAt: later(1440), accessExpiresAt: later(60) }, error: null }
/** The API: the old cookie is refused, the renewed one works. */
function serve(t: { mock: { method: typeof mock.method } }) {
  const sent: string[] = []
  t.mock.method(globalThis, 'fetch', async (_input: string, init: RequestInit) => {
    const sentCookie = new Headers(init.headers).get('cookie') ?? ''
    sent.push(sentCookie)
    return sentCookie.includes('session_token=new') ? Response.json({ ok: true }) : Response.json({ error: 'unauthorized' }, { status: 401 })
  })
  return sent
}

test('concurrent 401s share one rotation and each request is replayed once with the renewed cookie', async t => {
  signedIn('10')
  const sent = serve(t)
  let release!: () => void
  const gate = new Promise<void>(done => { release = done })
  rotateAnswer = async () => { await gate; cookie = 'better-auth.session_token=new'; return renewed }
  const reads = Promise.all([1, 2, 3].map(n => api(`/api/mobile/read-${n}`)))
  await new Promise(resolve => setTimeout(resolve, 10))
  release()
  assert.deepEqual(await reads, [{ ok: true }, { ok: true }, { ok: true }])
  assert.deepEqual(authCalls, ['/mobile-refresh/rotate'])
  assert.equal(sent.filter(value => value.includes('old')).length, 3)
  assert.equal(sent.filter(value => value.includes('new')).length, 3, 'one replay each')
  assert.equal(refused, 0)
  assert.equal(JSON.parse(keychain.get(accountStorageKey('10', 'refresh'))!).refreshToken, renewed.data.refreshToken)
})

test('a request still refused after its one replay goes to the session check, not another rotation', async t => {
  signedIn('11')
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'unauthorized' }, { status: 401 }))
  rotateAnswer = async () => { cookie = 'better-auth.session_token=new'; return renewed }
  await assert.rejects(api('/api/mobile/settings'), { status: 401 })
  assert.deepEqual(authCalls, ['/mobile-refresh/rotate'])
  assert.equal(refused, 1)
})

test('refreshRejected ends the credential and leaves the 401 to the session check, which signs out', async t => {
  signedIn('12')
  serve(t)
  rotateAnswer = async () => ({ data: null, error: { status: 401, code: 'refreshRejected' } })
  await assert.rejects(api('/api/mobile/settings'), { status: 401 })
  assert.equal(refused, 1)
  assert.equal(keychain.has(accountStorageKey('12', 'refresh')), false)
})

test('a 5xx, a 404 (a server without refresh) or no network from rotate never signs out', async t => {
  for (const [account, answer] of [
    ['13', async () => ({ data: null, error: { status: 503 } })],
    ['14', async () => ({ data: null, error: { status: 404 } })],
    ['15', async () => { throw new TypeError('Network request failed') }],
  ] as const) {
    signedIn(account)
    serve(t)
    rotateAnswer = answer
    await assert.rejects(api('/api/mobile/settings'), { status: 401 })
    assert.equal(refused, 0, `account ${account}: still signed in`)
    assert.ok(keychain.has(accountStorageKey(account, 'refresh')), 'the credential is kept for the next try')
  }
})

test('no refresh credential: a 401 goes straight to the session check, as before', async t => {
  signedIn('16')
  keychain.delete(accountStorageKey('16', 'refresh'))
  serve(t)
  await assert.rejects(api('/api/mobile/settings'), { status: 401 })
  assert.deepEqual(authCalls, [])
  assert.equal(refused, 1)
})

test('an access session about to end is renewed before the request goes out', async t => {
  signedIn('17', 2)
  const sent = serve(t)
  rotateAnswer = async () => { cookie = 'better-auth.session_token=new'; return renewed }
  assert.deepEqual(await api('/api/mobile/home'), { ok: true })
  assert.deepEqual(sent, ['better-auth.session_token=new'], 'the only request already carried the renewed cookie')
})

test('signed in without a credential, the app exchanges once', async () => {
  signedIn('18')
  keychain.delete(accountStorageKey('18', 'refresh'))
  await Promise.all([keepSignedIn('18', 'u1', 's1'), keepSignedIn('18', 'u1', 's1')])
  await keepSignedIn('18', 'u1', 's1')
  assert.deepEqual(authCalls, ['/mobile-refresh/exchange'])
  assert.equal(JSON.parse(keychain.get(accountStorageKey('18', 'refresh'))!).userId, 'u1')
})

test('a replay keeps the workspace its request was made in, even after a switch during renewal', async t => {
  signedIn('19')
  keychain.set(accountStorageKey('19', 'workspace'), 'design')
  const sent = serve(t)
  rotateAnswer = async () => {
    // The person switches workspace while the session renews.
    keychain.set(accountStorageKey('19', 'workspace'), 'engineering')
    cookie = 'better-auth.session_token=new'
    return renewed
  }
  assert.deepEqual(await api('/api/conversations/read-state', { method: 'POST', body: { all: true } }), { ok: true })
  assert.deepEqual(sent, ['better-auth.session_token=old; mikka-workspace=design', 'better-auth.session_token=new; mikka-workspace=design'])
})
