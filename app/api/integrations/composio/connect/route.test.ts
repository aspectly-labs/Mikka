import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { NextRequest, NextResponse } from '@/lib/server-runtime/server'

/** Rows each pool query returns, by the statement it runs. */
let readRows: Record<string, unknown>[] = []
let claimRows: Record<string, unknown>[] = []
const linked: unknown[][] = []
let composio: { create: (userId: string) => Promise<{ authorize: (toolkit: string) => Promise<{ redirectUrl: string; id: string }> }> } | null = null
let authorized: [string, string] | null = null
let sessionUser: string | null = 'app-user'

const intent = {
  tokenHash: 'h', userId: 'app-user', toolkit: 'gmail', replaceAccountId: null,
  returnTo: 'http://127.0.0.1:43123/return', returnState: 's'.repeat(43),
}
const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports: exports })
mock.module('@/lib/server-runtime/server', { namedExports: { NextRequest, NextResponse, after: () => {} } })
stub('../../../../../lib/request-log.ts', { noteLogUser: () => {}, withRequestLog: (_path: string, handler: unknown) => handler })
stub('../../../../../lib/auth.ts', { auth: { api: { getSession: async () => sessionUser ? { user: { id: sessionUser } } : null } }, authBaseURL: 'https://example.test' })
stub('../../../../../lib/composio.ts', { getComposio: () => composio })
stub('../../../../../lib/composio-config.ts', { isComposioCallbackVerifierConfigured: () => true })
stub('../../../../../lib/db/index.ts', { pool: { query: async (sql: string, params: unknown[]) => {
  if (sql.includes('SET "usedAt"')) return { rows: claimRows }
  if (sql.includes('SET "linkId"')) { linked.push(params); return { rows: [] } }
  return { rows: readRows }
} } })
let GET: typeof import('./route').GET
before(async () => { GET = (await import('./route')).GET })
function request(token: string) {
  return new NextRequest(`https://example.test/api/integrations/composio/connect?intent=${token}`)
}
function setup() {
  readRows = []; claimRows = []; linked.length = 0; authorized = null; sessionUser = 'app-user'
  composio = { create: async (userId: string) => ({ authorize: async (toolkit: string) => { authorized = [userId, toolkit]; return { redirectUrl: 'https://connect.composio.dev/link/l1', id: 'conn-1' } } }) }
}

test('a live intent opens the provider straight away and names the connected account for its callback', async () => {
  setup()
  readRows = [intent]; claimRows = [intent]
  const response = await GET(request('coi_' + 't'.repeat(43)))
  assert.equal(response.headers.get('location'), 'https://connect.composio.dev/link/l1')
  assert.deepEqual(authorized, ['app-user', 'gmail'])
  assert.deepEqual(linked, [['h', 'conn-1']])
  assert.match(response.headers.get('set-cookie') ?? '', /mikka_composio_flow=/)
})

test('a spent or dead intent answers failed on the loopback it named', async () => {
  setup()
  readRows = [intent]; claimRows = []
  const response = await GET(request('coi_' + 't'.repeat(43)))
  const back = new URL(response.headers.get('location')!)
  assert.equal(`${back.origin}${back.pathname}`, 'http://127.0.0.1:43123/return')
  assert.equal(back.searchParams.get('state'), 's'.repeat(43))
  assert.equal(back.searchParams.get('result'), 'failed')
})

test('an intent the account store refuses goes back to integrations, not a loopback it never gave', async () => {
  setup()
  const response = await GET(request('coi_' + 't'.repeat(43)))
  const back = new URL(response.headers.get('location')!)
  assert.equal(back.searchParams.get('composio'), 'callback-failed')
  assert.equal(back.searchParams.get('settings'), 'integrations')
})

test('a browser that is not the intent\'s account must sign in first and spends nothing', async () => {
  setup()
  readRows = [intent]; claimRows = [intent]
  for (const user of [null, 'other-user']) {
    sessionUser = user
    const response = await GET(request('coi_' + 't'.repeat(43)))
    const signin = new URL(response.headers.get('location')!)
    assert.equal(signin.pathname, '/sign-in')
    assert.equal(signin.searchParams.get('next'), '/api/integrations/composio/connect?intent=coi_' + 't'.repeat(43))
    assert.equal(authorized, null)
    assert.equal(linked.length, 0)
  }
})

test('a link the provider cannot start answers failed on the loopback', async () => {
  setup()
  readRows = [intent]; claimRows = [intent]
  composio = { create: async () => ({ authorize: async () => { throw new Error('upstream') } }) }
  const response = await GET(request('coi_' + 't'.repeat(43)))
  assert.equal(new URL(response.headers.get('location')!).searchParams.get('result'), 'failed')
})
