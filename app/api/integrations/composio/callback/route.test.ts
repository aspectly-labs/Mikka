import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { RouteRequest, RouteResponse } from '@/lib/server-runtime/server'

let followUpResult = true
let listFails = false
let linkIntent: { userId: string; returnTo: string; returnState: string; replaceAccountId?: string | null } | null = null
let completedWith: string | null = null
let sessionUser: string | null = 'synthetic-user'
const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports: exports })
mock.module('@/lib/server-runtime/server', { namedExports: { RouteRequest, RouteResponse, after: () => {} } })
stub('../../../../../lib/request-log.ts', { noteLogRpcAction: () => {}, noteLogUser: () => {}, withRequestLog: (_path: string, handler: unknown) => handler })
stub('../../../../../lib/auth.ts', { auth: { api: { getSession: async () => sessionUser ? { user: { id: sessionUser } } : null } }, authBaseURL: 'https://example.test' })
stub('../../../../../lib/composio.ts', { getComposio: () => ({ connectedAccounts: { completeAuth: async ({ userId }: { userId: string }) => { completedWith = userId; return { connectedAccountId: 'new' } }, list: async () => ({ items: [] }) } }), readComposioAccountEmail: () => {}, renameComposioAccount: () => {}, retireComposioAccount: () => {} })
stub('../../../../../lib/composio-connect-intent.ts', { composioConnectIntentByLink: async () => linkIntent })
stub('../../../../../lib/db/index.ts', { pool: {} })
stub('../../../../../lib/composio-account-store.ts', { chooseComposioDefault: () => {}, listComposioAccountRecords: async () => [], noteComposioEmailAttempt: () => {}, saveComposioAccountEmail: () => {} })
stub('../../../../../lib/composio-connect.ts', { followUpComposioConnect: async () => followUpResult })
stub('../../../../../lib/composio-pagination.ts', { listComposioPages: async () => { if (listFails) throw new Error('unavailable'); return [] } })
stub('../../../../../lib/composio-config.ts', { isComposioCallbackVerifierConfigured: () => true })
stub('../../../../../lib/suggestions/sources.ts', { bootstrapSuggestions: () => {} })
let GET: typeof import('./route').GET
before(async () => { GET = (await import('./route')).GET })
function request(replace: string | null = 'old') {
  const flow = Buffer.from(JSON.stringify({ link: 'new', replace: replace ?? undefined, returnTo: '/?settings=integrations' })).toString('base64url')
  return new RouteRequest('https://example.test/api/integrations/composio/callback?session_uri=synthetic', { headers: { cookie: `mikka_composio_flow=${flow}` } })
}
test('reconnect redirects to failure if follow-up fails or the account list cannot be read', async () => {
  followUpResult = false; listFails = false
  let response = await GET(request())
  assert.equal(new URL(response.headers.get('location')!).searchParams.get('composio'), 'callback-failed')
  followUpResult = true; listFails = true
  response = await GET(request())
  assert.equal(new URL(response.headers.get('location')!).searchParams.get('composio'), 'callback-failed')
  listFails = false
  response = await GET(request())
  assert.equal(new URL(response.headers.get('location')!).searchParams.get('composio'), 'connected')
})

test('a desktop link answers on its loopback with the intent\'s account, session or not', async () => {
  linkIntent = { userId: 'app-user', returnTo: 'http://127.0.0.1:43123/return', returnState: 's'.repeat(43), replaceAccountId: null }
  try {
    const response = await GET(request())
    const back = new URL(response.headers.get('location')!)
    assert.equal(`${back.origin}${back.pathname}`, 'http://127.0.0.1:43123/return')
    assert.equal(back.searchParams.get('state'), 's'.repeat(43))
    assert.equal(back.searchParams.get('result'), 'connected')
    assert.equal(completedWith, 'app-user')
  } finally { linkIntent = null; completedWith = null }
})

test('a desktop callback with no browser session still completes for the intent and answers its loopback', async () => {
  sessionUser = null
  linkIntent = { userId: 'app-user', returnTo: 'http://127.0.0.1:43123/return', returnState: 's'.repeat(43), replaceAccountId: null }
  try {
    const response = await GET(request())
    const back = new URL(response.headers.get('location')!)
    assert.equal(`${back.origin}${back.pathname}`, 'http://127.0.0.1:43123/return')
    assert.equal(back.searchParams.get('result'), 'connected')
    assert.equal(completedWith, 'app-user')
  } finally { sessionUser = 'synthetic-user'; linkIntent = null; completedWith = null }
})

test('a first connection cannot report success when the owned account list is unavailable', async () => {
  followUpResult = true; listFails = true
  try {
    const response = await GET(request(null))
    assert.equal(new URL(response.headers.get('location')!).searchParams.get('composio'), 'callback-failed')
  } finally { listFails = false }
})
