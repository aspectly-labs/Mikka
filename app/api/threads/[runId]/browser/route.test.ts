import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

let signedIn = true, resolves: string | null = 'viewer', seen: { userId?: string; workspaceId?: string; runId?: string } = {}
const identity = { id: 'owner' }
const ticket = { url: 'wss://sandbox.example/agents/run-one?token=tok', expiresAt: '2026-11-22T12:00:00.000Z' }
const RUN = '20000000-0000-4000-8000-000000000001'
mock.module(new URL('../../../../../lib/api-auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: async () => signedIn ? { user: identity } : null } } } })
mock.module(new URL('../../../../../lib/workspace-access.ts', import.meta.url).href, { namedExports: { loadWorkspaceContext: async () => ({ workspace: { id: 'workspace-one' } }) } })
mock.module(new URL('../../../../../lib/cloud-computer/subagent-browser.ts', import.meta.url).href, { namedExports: { resolveThreadBrowserViewer: async (input: { userId: string; workspaceId: string; runId: string }) => { seen = input; if (!resolves) throw new Error('Thread browser unavailable'); return ticket } } })
let POST: typeof import('./route')['POST']
before(async () => { ({ POST } = await import('./route')) })
beforeEach(() => { signedIn = true; resolves = 'viewer'; seen = {} })

function request(overrides: { origin?: string | null } = {}) {
  return new Request(`https://mikka.example/api/threads/${RUN}/browser`, { method: 'POST', headers: { origin: overrides.origin === null ? '' : (overrides.origin ?? 'https://mikka.example') } })
}
const params = Promise.resolve({ runId: RUN })

test('the thread browser ticket is minted for the run owner and workspace', async () => {
  const response = await POST(request(), { params })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), ticket)
  assert.deepEqual(seen, { userId: 'owner', workspaceId: 'workspace-one', runId: RUN })
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
})

test('an unauthenticated viewer never reaches the resolver', async () => {
  signedIn = false
  const response = await POST(request(), { params })
  assert.equal(response.status, 401)
  assert.deepEqual(seen, {})
})

test('a cross-origin mint is refused', async () => {
  const response = await POST(request({ origin: 'https://evil.example' }), { params })
  assert.equal(response.status, 403)
  assert.deepEqual(seen, {})
})

test('a thread without a running cloud machine reports unavailable', async () => {
  resolves = null
  const response = await POST(request(), { params })
  assert.equal(response.status, 503)
})
