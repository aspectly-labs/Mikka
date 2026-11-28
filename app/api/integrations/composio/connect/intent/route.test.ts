import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { RouteRequest, RouteResponse } from '@/lib/server-runtime/server'
import { composioLoopback } from '@/lib/composio-connect-intent'

let sessionUser: string | null = 'app-user'
let composio: object | null = {}
let verifierConfigured = true
let accounts: { id: string; toolkit: { slug: string } }[] = []
const catalogChecks: string[] = []
const intents: Record<string, unknown>[] = []

const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports: exports })
mock.module('@/lib/server-runtime/server', { namedExports: { RouteRequest, RouteResponse, after: () => {} } })
stub('../../../../../../lib/request-log.ts', { noteLogUser: () => {}, noteLogRpcAction: () => {}, withRequestLog: (_path: string, handler: unknown) => handler })
stub('../../../../../../lib/fresh-session.ts', { freshSessionRoute: (handler: unknown) => handler, withFreshSession: (work: () => unknown) => work() })
stub('../../../../../../lib/auth.ts', { auth: { api: { getSession: async () => sessionUser ? { user: { id: sessionUser }, session: { id: 'intent-session' } } : null } }, authBaseURL: 'https://example.test' })
stub('../../../../../../lib/composio.ts', { getComposio: () => composio })
stub('../../../../../../lib/composio-config.ts', { isComposioCallbackVerifierConfigured: () => verifierConfigured })
stub('../../../../../../lib/db/index.ts', { pool: {} })
stub('../../../../../../lib/composio-pagination.ts', { listComposioPages: async () => accounts })
stub('../../../../../../lib/plugins/catalog.ts', { assertCatalogToolkit: async (_lister: unknown, toolkit: string) => { catalogChecks.push(toolkit) }, composioToolkitLister: (c: unknown) => c })
stub('../../../../../../lib/composio-connect-intent.ts', {
  composioLoopback,
  createComposioConnectIntent: async (_pool: unknown, intent: Record<string, unknown>) => { intents.push(intent); return { token: 'coi_' + 't'.repeat(43) } },
})

let POST: typeof import('./route').POST
before(async () => { POST = (await import('./route')).POST })
const loopback = { returnTo: 'http://127.0.0.1:43123/return', returnState: 's'.repeat(43) }
function post(body: unknown, origin = 'https://example.test') {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (origin) headers.origin = origin
  return POST(new RouteRequest('https://example.test/api/integrations/composio/connect/intent', { method: 'POST', headers, body: JSON.stringify(body) }))
}
function setup() {
  sessionUser = 'app-user'; composio = {}; verifierConfigured = true
  accounts = [{ id: 'acct-mine', toolkit: { slug: 'slack' } }]
  catalogChecks.length = 0; intents.length = 0
}

test('the intent route is a session-only, same-origin POST with a strict body and a real loopback', async () => {
  setup()
  sessionUser = null
  assert.equal((await post({ toolkit: 'gmail', loopback })).status, 401)
  setup()
  assert.equal((await post({ toolkit: 'gmail', loopback }, 'https://evil.test')).status, 403)
  for (const body of [null, {}, { toolkit: 'GMAIL', loopback }, { accountId: '', loopback }, { toolkit: 'gmail', loopback, extra: 1 }]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body))
  }
  assert.equal((await post({ toolkit: 'gmail', loopback: { returnTo: 'http://evil.test/return', returnState: 's'.repeat(43) } })).status, 400)
  assert.deepEqual(catalogChecks, [], 'no catalog or minting work happens before the gates')
})

test('a Composio outage or missing verifier answers 503, not a silent failure', async () => {
  setup()
  composio = null
  assert.equal((await post({ toolkit: 'gmail', loopback })).status, 503)
  setup()
  verifierConfigured = false
  assert.equal((await post({ toolkit: 'gmail', loopback })).status, 503)
})

test('a fresh toolkit mint names the toolkit; a reconnect names its own account', async () => {
  setup()
  const fresh = await post({ toolkit: 'gmail', loopback })
  assert.equal(fresh.status, 200)
  assert.equal(fresh.headers.get('cache-control'), 'no-store')
  assert.deepEqual(intents[0], { userId: 'app-user', toolkit: 'gmail', replaceAccountId: null, ...loopback })
  assert.deepEqual(catalogChecks, ['gmail'])

  setup()
  const reconnect = await post({ accountId: 'acct-mine', loopback })
  assert.equal(reconnect.status, 200)
  assert.deepEqual(intents[0], { userId: 'app-user', toolkit: 'slack', replaceAccountId: 'acct-mine', ...loopback })
  assert.deepEqual(catalogChecks, [], 'a reconnect does not re-check the catalog')

  setup()
  assert.equal((await post({ accountId: 'acct-theirs', loopback })).status, 404)
})
