import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

let signedIn = true, allowed = true, reads = 0
const identity = { id: 'owner' }
const issueId = '10000000-0000-4000-8000-000000000001'
const preview = {
  issueId, title: 'Fixture', issueStatus: 'in_progress', runId: '20000000-0000-4000-8000-000000000001',
  runStatus: 'running', outcome: null, lastReply: 'Working…', lastReplyAt: '2026-11-22T11:00:00.000Z', updatedAt: '2026-11-22T11:00:00.000Z',
}
mock.module(new URL('../../../../../lib/api-auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: async () => signedIn ? { user: identity } : null } } } })
mock.module(new URL('../../../../../lib/thread-preview.ts', import.meta.url).href, { namedExports: {
  readThreadPreview: async (userId: string, id: string) => { assert.equal(userId, identity.id); assert.equal(id, issueId); reads++; return allowed ? preview : null },
} })
let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })
const context = { params: Promise.resolve({ issueId }) }
beforeEach(() => { signedIn = true; allowed = true; reads = 0 })

test('unauthenticated preview still fails before its read', async () => {
  signedIn = false
  const response = await GET(new Request('https://mikka.example/api/threads/x/preview'), context)
  assert.equal(response.status, 401); assert.equal(reads, 0)
})

test('a non-member gets the same not-found as a missing thread', async () => {
  allowed = false
  const response = await GET(new Request('https://mikka.example/api/threads/x/preview'), context)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'threadNotFound' })
  assert.equal(reads, 1)
})

test('the projection rides a 30-second private cache', async () => {
  const response = await GET(new Request('https://mikka.example/api/threads/x/preview'), context)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), preview)
  assert.equal(response.headers.get('cache-control'), 'private, max-age=30')
})
