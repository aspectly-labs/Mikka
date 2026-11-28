import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

let grants = 0
const cookie = 'linear-oauth-state'
const callbackPath = '/api/integrations/linear/callback'
mock.module('@/lib/linear-sync/oauth', { namedExports: {
  LINEAR_OAUTH_STATE_COOKIE: cookie,
  stateCookieOptions: (maxAge: number) => ({ httpOnly: true, sameSite: 'lax', secure: true, path: callbackPath, maxAge }),
  createLinearAuthorizationUrl: async () => { grants++; return { state: 'browser-state', url: 'https://linear.app/oauth/authorize?state=browser-state' } },
  exchangeLinearCode: async (state: string, code: string, user: string) => { assert.deepEqual([state, code, user], ['browser-state', 'test-code', 'alice']) },
} })
mock.module('@/lib/issue-access', { namedExports: { requireUser: async () => ({ id: 'alice' }) } })
let storedState: string | undefined
mock.module('@/lib/server-runtime/headers', { namedExports: { cookies: async () => ({ get: () => ({ value: storedState }) }) } })
mock.module('@/lib/request-log', { namedExports: { withRequestLog: (_path: string, handle: unknown) => handle } })
mock.module('@/lib/primitives/define-route', { namedExports: {
  defineRoute: (_spec: unknown, fn: (ctx: { request: Request; user: { id: string } }) => Response) => (request: Request) => fn({ request, user: { id: 'alice' } }),
} })

test('the intended browser account starts read-only OAuth and its cookie must accompany the callback', async () => {
  const start = (await import('./route')).GET
  const callback = (await import('../callback/route')).GET
  const request = (account: string, site: string) => new Request('https://mikka.test/api/integrations/linear/connect?account=' + account, { headers: { 'sec-fetch-site': site } })
  for (const [account, site] of [['bob', 'none'], ['alice', 'cross-site']]) {
    const response = await start(request(account, site))
    assert.equal(new URL(response.headers.get('location')!).search, '?linear=error')
    assert.equal(response.headers.has('set-cookie'), false)
  }
  assert.equal(grants, 0)
  const response = await start(request('alice', 'same-origin'))
  assert.equal(new URL(response.headers.get('location')!).origin, 'https://linear.app')
  assert.match(response.headers.get('set-cookie')!, /linear-oauth-state=browser-state/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const finish = () => callback(new Request('https://mikka.test' + callbackPath + '?state=browser-state&code=test-code'))
  assert.equal(new URL((await finish()).headers.get('location')!).search, '?linear=error')
  storedState = 'browser-state'
  assert.equal(new URL((await finish()).headers.get('location')!).search, '?linear=connected')
})
