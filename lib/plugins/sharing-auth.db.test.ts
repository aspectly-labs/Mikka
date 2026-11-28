import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'

// Personal MCP servers are not shareable (decision 2026-11-27-1700). The retired share route keeps
// its human-session guard for one release and then answers 410; it never stores a grant.
// Uses real PAT authentication, membership and plugin storage.
// Only browser/native session verification and Next's request context are fixtures.
test('the retired MCP share route keeps its session boundary and stores nothing', { skip: !dbUrl, timeout: 60_000 }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  const owner = await seedUser(pool, 'mcp-human-owner'), peer = await seedUser(pool, 'mcp-human-peer')
  const home = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const team = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: peer, role: 'member' }])
  const nativeToken = randomBytes(32).toString('base64url')
  mock.module('@/lib/server-runtime/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) } })
  mock.module('@/lib/auth', { namedExports: {
    MOBILE_APP_ORIGIN: 'mikka://',
    auth: { api: { getSession: async ({ headers }: { headers: Headers }) => headers.get('cookie') === 'human-fixture' || headers.get('authorization') === `Bearer ${nativeToken}` ? {
      user: { id: owner, name: 'Fixture', email: `${owner}@example.invalid`, image: null }, session: { id: 'synthetic-human-session' },
    } : null } },
  } })
  const { createLegacyPersonalAccessToken } = await import('../tokens/store')
  const token = await createLegacyPersonalAccessToken(owner, home.id, { name: 'Confined fixture token' })
  const { personalPlugins, workspaceMcp } = await import('./runtime')
  const server = await personalPlugins.createMcp(owner, { name: 'Private fixture', url: 'https://mcp.example.invalid/', transport: 'http', enabled: true })
  const route = await import('../../app/api/integrations/mcp/shares/route')
  const url = 'http://127.0.0.1/api/integrations/mcp/shares'
  const call = (headers: Record<string, string>, shared: boolean, workspaceId = team.id) => route.PATCH(new Request(url, { method: 'PATCH', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json', ...headers }, body: JSON.stringify({ serverId: server.id, workspaceId, shared }) }))
  const count = async () => (await pool.query('SELECT 1 FROM personal_mcp_workspace_shares WHERE server_id=$1', [server.id])).rowCount
  const peerServers = async () => (await workspaceMcp.freeze(peer, team.id)).servers.length
  t.after(async () => {
    mock.restoreAll()
    await pool.query('DELETE FROM personal_mcp_servers WHERE id=$1', [server.id])
    const [{ pool: appPool }, { workspacePool }] = await Promise.all([import('../db'), import('../workspace-db')])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  await t.test('a workspace PAT is still refused before the retired-sharing answer', async () => {
    const response = await call({ authorization: `Bearer ${token.token}` }, true)
    assert.deepEqual({ status: response.status, grants: await count(), peerServers: await peerServers() }, { status: 401, grants: 0, peerServers: 0 })
  })
  await t.test('an invalid delegated token is not rescued by a browser cookie', async () => {
    assert.equal((await call({ authorization: `Bearer mkp_${'x'.repeat(43)}`, cookie: 'human-fixture' }, true)).status, 401)
  })
  await t.test('a verified browser or native owner gets 410 sharing retired for both share and unshare; nothing is stored', async () => {
    for (const headers of [{ cookie: 'human-fixture' }, { authorization: `Bearer ${nativeToken}` }] as Record<string, string>[]) for (const shared of [true, false]) {
      const response = await call(headers, shared)
      assert.deepEqual({ status: response.status, body: await response.json() }, { status: 410, body: { error: 'mcpSharingRetired' } })
    }
    assert.deepEqual({ grants: await count(), peerServers: await peerServers() }, { grants: 0, peerServers: 0 })
    const page = await workspaceMcp.list(owner, team.id)
    assert.deepEqual({ canShare: page.canShare, shared: page.servers.map(item => item.shared) }, { canShare: false, shared: [false] })
  })
  await t.test('a human request with a foreign Origin remains refused', async () => {
    assert.equal((await call({ cookie: 'human-fixture', origin: 'https://elsewhere.example.invalid' }, true)).status, 403)
    assert.equal(await count(), 0)
  })
})
