import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

let signedIn = true
const identity = { id: 'owner', tokenWorkspaceId: '20000000-0000-4000-8000-000000000001' }
mock.module(new URL('../../../lib/api-auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: async () => signedIn ? { user: identity } : null } } } })
let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })
beforeEach(() => { signedIn = true })

test('unauthenticated list still fails', async () => {
  signedIn = false
  const response = await GET(new Request('https://mikka.example/api/pending-actions'))
  assert.equal(response.status, 401)
})

test('nothing waits for approval: an empty array with the private owner/read-time headers', async () => {
  const start = Date.now()
  const response = await GET(new Request('https://mikka.example/api/pending-actions'))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), [])
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('x-mikka-viewer'), 'owner')
  const observed = Date.parse(response.headers.get('x-mikka-observed-at') ?? '')
  assert.ok(observed >= start && observed <= Date.now())
})
