import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { sessionTokenOf } from '../lib/session-token.ts'

type SessionAnswer = { data: { user: { id: string } } | null; error: { status: number } | null }
let answer: () => Promise<SessionAnswer> = async () => ({ data: null, error: null })
let stored = '__Secure-better-auth.session_token=old.sig; __Secure-better-auth.session_data=cache'
let checks = 0, signOuts = 0, cleared = 0
const client = {
  getCookie: async () => stored,
  getSession: async () => { checks++; return answer() },
  signOut: async () => { signOuts++ },
  $store: { notify: () => {} },
}
const account = { id: 'legacy' }
mock.module('react-native', { namedExports: { Platform: { OS: 'web' } } })
mock.module(new URL('../lib/auth.ts', import.meta.url).href, { namedExports: { authClient: client } })
mock.module(new URL('../lib/config.ts', import.meta.url).href, { namedExports: { currentAccount: () => account, servers: { signedOut: async () => {} } } })
mock.module(new URL('../lib/api-cache.ts', import.meta.url).href, { namedExports: { apiCache: { clear: () => { cleared++ } } } })
const { sessionRefused, sessionExpired } = await import('../lib/session.ts')
const sent = '__Secure-better-auth.session_token=old.sig; mikka-workspace=w'
const reset = () => { checks = 0; signOuts = 0; cleared = 0; stored = '__Secure-better-auth.session_token=old.sig' }

test('the session token is read from the Cookie header the app sent', () => {
  assert.equal(sessionTokenOf(sent), 'old.sig')
  assert.equal(sessionTokenOf('better-auth.session_token=a; x=y'), 'a')
  assert.equal(sessionTokenOf('mikka-workspace=w'), null)
  assert.equal(sessionTokenOf(null), null)
})

test('several 401s for one session ask the auth server once, and a session it still knows stays signed in', async () => {
  reset()
  answer = async () => ({ data: { user: { id: 'u' } }, error: null })
  await Promise.all([1, 2, 3, 4, 5].map(() => sessionRefused(sent)))
  assert.equal(checks, 1)
  assert.equal(signOuts, 0)
  assert.equal(cleared, 0)
})

test('a check that cannot reach the server keeps the person signed in', async () => {
  reset()
  answer = async () => { throw new TypeError('Network request failed') }
  await sessionRefused(sent)
  answer = async () => ({ data: null, error: { status: 503 } })
  await sessionRefused(sent)
  assert.equal(signOuts, 0)
})

test('a session the auth server no longer knows signs out once', async () => {
  reset()
  answer = async () => ({ data: null, error: null })
  await Promise.all([sessionRefused(sent), sessionRefused(sent)])
  assert.equal(checks, 1)
  assert.equal(signOuts, 1)
  assert.equal(sessionExpired(), true)
})

test('a 401 for an older sign-in never signs out the session that replaced it', async () => {
  reset()
  // The request went out with the old token; the person has signed in again since.
  stored = '__Secure-better-auth.session_token=new.sig'
  answer = async () => ({ data: null, error: null })
  await sessionRefused(sent)
  assert.equal(checks, 0)
  assert.equal(signOuts, 0)
})

test('a sign-in that lands while the old session is being checked is kept', async () => {
  reset()
  answer = async () => { stored = '__Secure-better-auth.session_token=new.sig'; return { data: null, error: null } }
  await sessionRefused(sent)
  assert.equal(checks, 1)
  assert.equal(signOuts, 0)
  assert.equal(cleared, 0)
})

test('a revoked session whose cookie the auth client already cleared still signs out', async () => {
  reset()
  // Better Auth answers null and deletes the cookie; the Expo plugin applies that before getSession resolves.
  answer = async () => { stored = '__Secure-better-auth.session_data=cache'; return { data: null, error: null } }
  await sessionRefused(sent)
  assert.equal(signOuts, 1)
  assert.equal(cleared, 1)
})
