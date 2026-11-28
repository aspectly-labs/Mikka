import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

let signedIn = true, reads = 0
const identity = { id: 'owner' }
const overview = {
  needsYou: [{ kind: 'question', threadId: '10000000-0000-4000-8000-000000000001', createdAt: '2026-11-22T11:00:00.000Z', detail: 'question' }],
  running: [{ runId: '20000000-0000-4000-8000-000000000001', issueId: '10000000-0000-4000-8000-000000000001', title: 'Fixture', status: 'running', updatedAt: '2026-11-22T11:00:00.000Z' }],
  pullRequests: [{ issueId: '10000000-0000-4000-8000-000000000001', branch: 'feat', url: 'https://example.invalid/pr/1', state: 'open', status: 'published', updatedAt: '2026-11-22T11:00:00.000Z' }],
}
mock.module(new URL('../../../../lib/api-auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: async () => signedIn ? { user: identity } : null } } } })
mock.module(new URL('../../../../lib/coordinator/overview.ts', import.meta.url).href, { namedExports: { readCoordinatorOverview: async (user: { id: string }, workspaceId?: string) => { assert.equal(user.id, identity.id); assert.equal(workspaceId, requestedWorkspace); reads++; return overview } } })
let requestedWorkspace: string | undefined
let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })
beforeEach(() => { signedIn = true; reads = 0; requestedWorkspace = undefined })

test('unauthenticated overview still fails before its read', async () => {
  signedIn = false
  const response = await GET(new Request('https://mikka.example/api/coordinator/overview'))
  assert.equal(response.status, 401); assert.equal(reads, 0)
})

test('the overview aggregates needs-you, running work and pull requests with private headers', async () => {
  const response = await GET(new Request('https://mikka.example/api/coordinator/overview'))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), overview)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('x-mikka-viewer'), 'owner')
  assert.equal(reads, 1)
})

test('a named workspace reaches the overview reader', async () => {
  requestedWorkspace = 'workspace-one'
  const response = await GET(new Request('https://mikka.example/api/coordinator/overview?workspaceId=workspace-one'))
  assert.equal(response.status, 200)
  assert.equal(reads, 1)
})
