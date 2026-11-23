import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

let signedIn = true, allowed = true, reads = 0, writes: unknown[] = []
const identity = { id: 'owner' }
const issueId = '10000000-0000-4000-8000-000000000001'
const runId = '20000000-0000-4000-8000-000000000001'
const rootRunId = '20000000-0000-4000-8000-000000000002'
const state = { tabs: ['runs', 'files'], active: 'files', open: true }
const origin = 'https://mikka.example'
mock.module(new URL('../../../../../lib/api-auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: async () => signedIn ? { user: identity } : null } } } })
mock.module(new URL('../../../../../lib/thread-panel.ts', import.meta.url).href, { namedExports: {
  threadPanelStateSchema: (await import('../../../../../lib/thread-panel-schema')).threadPanelStateSchema,
  threadPanelAccess: async (user: { id: string }, id: string, run: string) => { assert.equal(user.id, identity.id); assert.equal(id, issueId); assert.equal(run, runId); return allowed ? rootRunId : null },
  readThreadPanelState: async (userId: string, root: string) => { assert.equal(root, rootRunId); reads++; return state },
  writeThreadPanelState: async (userId: string, root: string, next: unknown) => { assert.equal(root, rootRunId); writes.push(next) },
} })
let GET: typeof import('./route')['GET'], PUT: typeof import('./route')['PUT']
before(async () => { ({ GET, PUT } = await import('./route')) })
const context = { params: Promise.resolve({ issueId }) }
const get = (query = `?runId=${runId}`) => GET(new Request(`${origin}/api/threads/x/panel${query}`), context)
const put = (body: unknown, headers: Record<string, string> = {}, query = `?runId=${runId}`) => PUT(new Request(`${origin}/api/threads/x/panel${query}`, {
  method: 'PUT', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), context)
beforeEach(() => { signedIn = true; allowed = true; reads = 0; writes = [] })

test('unauthenticated read and write fail before any access check', async () => {
  signedIn = false
  assert.equal((await get()).status, 401)
  assert.equal((await put(state)).status, 401)
  assert.equal(reads, 0); assert.equal(writes.length, 0)
})

test('a missing or malformed runId is an input error, not a lookup miss', async () => {
  assert.equal((await get('')).status, 400)
  assert.equal((await get('?runId=not-a-uuid')).status, 400)
  assert.equal((await put(state, {}, '')).status, 400)
  assert.equal(reads, 0); assert.equal(writes.length, 0)
})

test('a non-member gets not-found on read and write alike (#2935 rejection)', async () => {
  allowed = false
  assert.equal((await get()).status, 404)
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

test('the member reads and replaces the whole layout state keyed by the root run', async () => {
  const read = await get()
  assert.equal(read.status, 200)
  assert.deepEqual(await read.json(), state)
  assert.equal(read.headers.get('cache-control'), 'private, no-store')
  const written = await put({ tabs: ['files'], active: 'files', open: false })
  assert.equal(written.status, 200)
  assert.deepEqual(await written.json(), { tabs: ['files'], active: 'files', open: false })
  assert.equal(writes.length, 1)
})
