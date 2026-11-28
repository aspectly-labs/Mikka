import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

let signedIn = true, reads = 0
const identity = { id: 'owner' }
const items = [
  { kind: 'approval', threadId: null, createdAt: '2026-11-22T10:00:00.000Z', detail: 'send_email' },
  { kind: 'question', threadId: '10000000-0000-4000-8000-000000000001', createdAt: '2026-11-22T11:00:00.000Z', detail: 'pr_review' },
]
mock.module(new URL('../../../lib/api-auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: async () => signedIn ? { user: identity } : null } } } })
mock.module(new URL('../../../lib/needs-you.ts', import.meta.url).href, { namedExports: { listNeedsYou: async (user: { id: string }) => { assert.equal(user.id, identity.id); reads++; return items } } })
let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })
beforeEach(() => { signedIn = true; reads = 0 })

test('unauthenticated list still fails before its read', async () => {
  signedIn = false
  const response = await GET(new Request('https://mikka.example/api/needs-you'))
  assert.equal(response.status, 401); assert.equal(reads, 0)
})

test('the projection keeps every kind, thread and source detail with private headers', async () => {
  const start = Date.now()
  const response = await GET(new Request('https://mikka.example/api/needs-you'))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), items)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('x-mikka-viewer'), 'owner')
  const observed = Date.parse(response.headers.get('x-mikka-observed-at') ?? '')
  assert.ok(observed >= start && observed <= Date.now())
  assert.equal(reads, 1)
})
