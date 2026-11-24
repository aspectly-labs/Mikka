import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

type SessionAnswer = { data: { user: { id: string } } | null; error: { status: number } | null }
let answer: Promise<SessionAnswer> = Promise.resolve({ data: null, error: null })
let checks = 0, signOuts = 0
const client = {
  getSession: async () => { checks++; return answer },
  signOut: async () => { signOuts++ },
  $store: { notify: () => {} },
}
const account = { id: 'legacy' }
mock.module('react-native', { namedExports: { Platform: { OS: 'web' } } })
mock.module(new URL('../lib/auth.ts', import.meta.url).href, { namedExports: { authClient: client } })
mock.module(new URL('../lib/config.ts', import.meta.url).href, { namedExports: { currentAccount: () => account, servers: { signedOut: async () => {} } } })
mock.module(new URL('../lib/api-cache.ts', import.meta.url).href, { namedExports: { apiCache: { clear: () => {} } } })
mock.module(new URL('../lib/session-cookie.ts', import.meta.url).href, { namedExports: { keepRenewedSession: async () => {} } })
const { sessionRefused } = await import('../lib/session.ts')

test('several 401s at once ask the auth server once, and a session it still knows stays signed in', async () => {
  checks = 0; signOuts = 0
  answer = Promise.resolve({ data: { user: { id: 'u' } }, error: null })
  await Promise.all([sessionRefused(), sessionRefused(), sessionRefused(), sessionRefused(), sessionRefused()])
  assert.equal(checks, 1)
  assert.equal(signOuts, 0)
})

test('a check that cannot reach the server keeps the person signed in', async () => {
  checks = 0; signOuts = 0
  answer = Promise.reject(new TypeError('Network request failed'))
  await sessionRefused()
  answer = Promise.resolve({ data: null, error: { status: 503 } })
  await sessionRefused()
  assert.equal(signOuts, 0)
})

test('a session the auth server no longer knows signs out once', async () => {
  checks = 0; signOuts = 0
  answer = Promise.resolve({ data: null, error: null })
  await Promise.all([sessionRefused(), sessionRefused()])
  assert.equal(checks, 1)
  assert.equal(signOuts, 1)
  answer = Promise.resolve({ data: null, error: { status: 401 } })
  await sessionRefused()
  assert.equal(signOuts, 2)
})
