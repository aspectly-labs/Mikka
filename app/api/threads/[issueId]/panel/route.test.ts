import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

let signedIn = true, allowed = true, reads = 0, writes: unknown[] = []
const identity = { id: 'owner' }
const issueId = '10000000-0000-4000-8000-000000000001'
const state = { tabs: ['runs', 'files'], active: 'files', open: true }
const origin = 'https://mikka.example'
mock.module(new URL('../../../../../lib/api-auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: async () => signedIn ? { user: identity } : null } } } })
mock.module(new URL('../../../../../lib/thread-panel.ts', import.meta.url).href, { namedExports: {
  threadPanelStateSchema: (await import('../../../../../lib/thread-panel-schema')).threadPanelStateSchema,
  threadPanelAccess: async (userId: string, id: string) => { assert.equal(userId, identity.id); assert.equal(id, issueId); return allowed },
  readThreadPanelState: async () => { reads++; return state },
  writeThreadPanelState: async (userId: string, id: string, next: unknown) => { writes.push(next) },
} })
let GET: typeof import('./route')['GET'], PUT: typeof import('./route')['PUT']
before(async () => { ({ GET, PUT } = await import('./route')) })
const context = { params: Promise.resolve({ issueId }) }
const put = (body: unknown, headers: Record<string, string> = {}) => PUT(new Request(`${origin}/api/threads/x/panel`, {
  method: 'PUT', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), context)
beforeEach(() => { signedIn = true; allowed = true; reads = 0; writes = [] })

test('unauthenticated read and write fail before any access check', async () => {
  signedIn = false
  assert.equal((await GET(new Request(`${origin}/api/threads/x/panel`), context)).status, 401)
  assert.equal((await put(state)).status, 401)
  assert.equal(reads, 0); assert.equal(writes.length, 0)
})

test('a non-member gets not-found on read and write alike (#2935 rejection)', async () => {
  allowed = false
  assert.equal((await GET(new Request(`${origin}/api/threads/x/panel`), context)).status, 404)
  assert.equal((await put(state)).status, 404)
  assert.equal(reads, 0); assert.equal(writes.length, 0)
})

test('a cross-origin write is refused before the body is trusted', async () => {
  const response = await put(state, { origin: 'https://elsewhere.example' })
  assert.equal(response.status, 403)
  assert.equal(writes.length, 0)
})

test('a malformed body writes nothing', async () => {
  const response = await put({ tabs: 'runs' })
  assert.equal(response.status, 400)
  assert.equal(writes.length, 0)
})

test('the member reads and replaces the whole layout state', async () => {
  const read = await GET(new Request(`${origin}/api/threads/x/panel`), context)
  assert.equal(read.status, 200)
  assert.deepEqual(await read.json(), state)
  assert.equal(read.headers.get('cache-control'), 'private, no-store')
  const written = await put({ tabs: ['files'], active: 'files', open: false })
  assert.equal(written.status, 200)
  assert.deepEqual(await written.json(), { tabs: ['files'], active: 'files', open: false })
  assert.equal(writes.length, 1)
})
