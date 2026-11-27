import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'
import { Pool } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { isE2eTarget, E2E_DB_RULE } from '../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'
import { PersonalPluginStore } from './store'
import { lockNativeMcpAuthority, WorkspaceMcpStore } from './workspace-mcp'
import { WorkspaceMcpServers } from './workspace-servers'
import { nativeMcpName, withLockedToolSwitches } from './native-mcp'
import { createMcpSchema, createWorkspaceMcpSchema, type McpAuthority, type PersonalPluginSnapshot } from './contracts'
import { createPersonalMcpRuntime } from './mcp'

const database = process.env.E2E_DATABASE_URL
if (database) assert.ok(isE2eTarget(database), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') throw Error('Workspace MCP server tests require an isolated E2E_DATABASE_URL')

// Capy's organization MCP servers (decision 2026-11-27-1705): real MCP SDK handshakes and
// the SDK's own OAuth code flow against local fixtures; no third-party service or model I/O.
test('workspace MCP servers: any member manages them, threads resolve by their starter, and accounts never cross members', { skip: !database, timeout: 180_000 }, async t => {
  const isolated = `workspace_servers_${randomUUID().replaceAll('-', '')}_e2e`
  const admin = new Pool({ connectionString: database })
  await createTestDatabase(admin, isolated, 'template0')
  const target = new URL(database!); target.pathname = `/${isolated}`
  const pool = new Pool({ connectionString: target.toString(), max: 8 })
  const alice = 'org-mcp-alice', bob = 'org-mcp-bob', carol = 'org-mcp-carol', mallory = 'org-mcp-mallory'
  const workspace = randomUUID(), foreign = randomUUID(), solo = randomUUID(), environment = randomUUID()
  // Each sign-in code issues its own account's bearer; the fixture reports which account a call used.
  const accounts: Record<string, string> = { 'code-alice': `token-alice-${randomUUID()}`, 'code-bob': `token-bob-${randomUUID()}`, 'code-shared': `token-shared-${randomUUID()}` }
  const owners = new Map(Object.entries(accounts).map(([code, token]) => [token, code.slice(5)]))
  const challenges = new Set<string>()
  const used: string[] = []
  let calls = 0
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname
    const send = (body: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
    if (path.startsWith('/.well-known/oauth-protected-resource')) return send({ resource: 'https://tracker.example.com/tracker', authorization_servers: ['https://oauth.example.com'] })
    if (path.startsWith('/.well-known/oauth-authorization-server') || path.startsWith('/.well-known/openid-configuration')) return send({
      issuer: 'https://oauth.example.com', authorization_endpoint: 'https://oauth.example.com/authorize', token_endpoint: 'https://oauth.example.com/token', registration_endpoint: 'https://oauth.example.com/register',
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    })
    let body = ''; for await (const chunk of request) body += chunk
    if (path === '/register') return send({ client_id: 'fixture-client', ...JSON.parse(body) })
    if (path === '/token') {
      const params = new URLSearchParams(body)
      assert.ok(challenges.has(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')))
      return send({ access_token: accounts[params.get('code')!], token_type: 'Bearer', expires_in: 3600 })
    }
    if (request.method === 'GET') return send({}, 405)
    if (request.method === 'DELETE') return send({})
    const tracker = path === '/tracker'
    const bearer = request.headers.authorization?.replace(/^Bearer /, '')
    if (tracker && !owners.has(bearer ?? '')) return send({ error: 'unauthorized' }, 401)
    if (!tracker && !request.headers['x-account']) return send({ error: 'unauthorized' }, 401)
    const input = JSON.parse(body)
    if (!('id' in input)) { response.writeHead(202); response.end(); return }
    if (input.method === 'tools/call') { calls++; used.push(tracker ? owners.get(bearer!)! : String(request.headers['x-account'])) }
    send({ jsonrpc: '2.0', id: input.id, result: input.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'org-fixture', version: '1' } }
      : input.method === 'tools/list' ? { tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }, { name: 'write', description: 'Write', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'done' }] } })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const localFetch: typeof fetch = (input, init) => { const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); return fetch(address + url.pathname + url.search, init) }
  const transport = () => ({ fetch: localFetch, close: async () => {} })
  const env = { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex'), BETTER_AUTH_URL: 'https://app.example.com' }
  // The claim fence reads membership through the default workspace pool.
  const saved = { MIKKA_DATABASE_URL: process.env.MIKKA_DATABASE_URL, DATABASE_URL: process.env.DATABASE_URL }
  Object.assign(process.env, { MIKKA_DATABASE_URL: target.toString(), DATABASE_URL: target.toString() })
  try {
    const directory = new URL('../../drizzle/', import.meta.url)
    for (const migration of orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql')))) await pool.query(await readFile(new URL(migration, directory), 'utf8'))
    // Replayable: the migration applies twice without change.
    await pool.query(await readFile(new URL('20261127170716_workspace_mcp_servers.sql', directory), 'utf8'))
    assert.match((await pool.query('SHOW server_version')).rows[0].server_version, /^17\./)
    for (const user of [alice, bob, carol, mallory]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [user, `${user}@example.invalid`])
    for (const [id, kind, users] of [[workspace, 'team', [alice, bob, carol]], [foreign, 'team', [mallory]], [solo, 'personal', [alice]]] as const) {
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,\'Org MCP fixture\',$3)', [id, users[0], kind])
      for (const user of users) await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,$4,\'active\')', [id, user, `${user}@example.invalid`, user === users[0] ? 'admin' : 'member'])
    }
    await pool.query('INSERT INTO workspace_environments(id,"workspaceId",name,configuration,"createdBy","updatedBy") VALUES($1,$2,\'Fixture\',\'{}\',$3,$3)', [environment, workspace, alice])

    const servers = new WorkspaceMcpServers(pool, env, pool, { transport }, transport)
    const personal = new PersonalPluginStore(pool, env, pool, undefined, servers)
    const freezer = new WorkspaceMcpStore(pool, pool)
    const runtime = createPersonalMcpRuntime(personal, { transport })
    const snapshot = (authority: McpAuthority): PersonalPluginSnapshot => ({ servers: authority.servers.map(({ id, name, revision }) => ({ id, name, revision })), skills: [], mcpAuthority: authority })
    const call = (user: string, authority: McpAuthority, serverId: string, name = 'read') => runtime(user, snapshot(authority), { serverId, name, arguments: {} })
    const docsInput = createWorkspaceMcpSchema.parse({ name: 'Docs', url: 'https://docs.example.com/docs', headers: { 'X-Account': 'workspace-account' } })
    let docs = await servers.create(alice, workspace, docsInput)

    await t.test('a new server is Shared, as Capy, and any active member can edit, switch tools and see it', async () => {
      assert.equal(docs.connectionMode, 'shared'); assert.equal(docs.group, 'organization'); assert.equal(docs.serverKey, 'docs'); assert.equal(docs.authKind, 'header')
      assert.ok(!JSON.stringify(docs).includes('workspace-account'))
      const checked = await servers.check(bob, workspace, docs.id)
      assert.equal(checked.status, 'connected'); assert.deepEqual(checked.tools.map(tool => tool.name), ['read', 'write'])
      const renamed = await servers.update(carol, workspace, docs.id, { name: 'Team docs', expectedRevision: docs.revision })
      assert.equal(renamed.name, 'Team docs'); assert.equal(renamed.revision, docs.revision + 1)
      await assert.rejects(servers.update(bob, workspace, docs.id, { name: 'Stale', expectedRevision: docs.revision }), /mcpConnectionChanged/)
      const before = renamed.revision
      await servers.setTool(bob, workspace, docs.id, 'write', false, { expectedEnabled: true })
      await assert.rejects(servers.setTool(carol, workspace, docs.id, 'write', false, { expectedEnabled: true }), /mcpConnectionChanged/)
      docs = await servers.detail(alice, workspace, docs.id)
      assert.equal(docs.revision, before); assert.equal(docs.tools.find(tool => tool.name === 'write')?.enabled, false)
      assert.equal((await servers.list(carol, workspace)).count, 1)
      // A second server derives the next free key; a named key that is taken is refused.
      const other = await servers.create(bob, workspace, createWorkspaceMcpSchema.parse({ name: 'Docs', url: 'https://docs.example.com/other' }))
      assert.equal(other.serverKey, 'docs-2')
      await assert.rejects(servers.create(bob, workspace, createWorkspaceMcpSchema.parse({ name: 'X', serverKey: 'docs', url: 'https://docs.example.com/x' })), /mcpServerKeyTaken/)
      await assert.rejects(servers.update(bob, workspace, other.id, { connectionMode: 'member' }), /mcpConnectionModeUnavailable/)
      assert.deepEqual(await servers.remove(carol, workspace, other.id), { deleted: true })
      // A personal workspace has no organization servers to add.
      await assert.rejects(servers.create(alice, solo, docsInput), /workspaceAccessDenied/)
    })

    await t.test('another workspace sees, edits, connects and runs nothing', async () => {
      await assert.rejects(servers.list(mallory, workspace), /workspaceAccessDenied/)
      await assert.rejects(servers.detail(mallory, workspace, docs.id), /workspaceAccessDenied/)
      await assert.rejects(servers.update(mallory, workspace, docs.id, { enabled: false }), /workspaceAccessDenied/)
      await assert.rejects(servers.setTool(mallory, workspace, docs.id, 'read', false), /workspaceAccessDenied/)
      await assert.rejects(servers.connect(mallory, workspace, docs.id), /workspaceAccessDenied/)
      await assert.rejects(servers.remove(mallory, workspace, docs.id), /workspaceAccessDenied/)
      // Wrong workspace in the path: the server is not found there.
      await assert.rejects(servers.detail(mallory, foreign, docs.id), /mcpNotFound/)
      assert.equal((await freezer.freeze(mallory, foreign)).servers.length, 0)
      // A forged grant under another workspace's authority is refused before any call.
      const forged: McpAuthority = { requester: mallory, workspaceId: foreign, servers: [{ id: docs.id, name: docs.name, revision: docs.revision, ownerId: mallory, grantId: null, source: 'workspace', mode: 'shared' }] }
      await assert.rejects(freezer.validate(mallory, forged), /mcpUnavailable/)
      const before = calls
      assert.deepEqual(await call(mallory, forged, docs.id), { error: 'mcpUnavailable' })
      assert.equal(calls, before)
    })

    await t.test('a thread uses the workspace servers plus its starter\'s own; on a key clash the starter\'s own wins', async () => {
      const bobs = await freezer.freeze(bob, workspace)
      assert.deepEqual(bobs.servers.map(grant => [grant.id, grant.source, grant.mode, grant.ownerId]), [[docs.id, 'workspace', 'shared', bob]])
      assert.ok(!('error' in await call(bob, bobs, docs.id)))
      assert.equal(used.at(-1), 'workspace-account')
      // The tool switch applies to every member's runs.
      assert.deepEqual(await call(bob, bobs, docs.id, 'write'), { error: 'mcpToolDisabled' })
      const mine = await personal.createMcp(alice, createMcpSchema.parse({ name: 'Docs', url: 'https://docs.example.com/docs', headers: { 'X-Account': 'alice-private-account' } }))
      // "Team docs" was renamed but keeps the key "docs", which Alice's own "Docs" also has.
      const alices = await freezer.freeze(alice, workspace)
      assert.deepEqual(alices.servers.map(grant => grant.id), [mine.id])
      assert.ok(!('error' in await call(alice, alices, mine.id)))
      assert.equal(used.at(-1), 'alice-private-account')
      assert.deepEqual(await call(alice, alices, docs.id), { error: 'mcpNotEnabledForExecution' })
      assert.equal((await servers.list(alice, workspace)).servers[0].shadowedByPersonal, true)
      assert.equal((await servers.list(bob, workspace)).servers[0].shadowedByPersonal, false)
      // Resolution is the frozen requester's: Bob's run never picks up Alice's private server.
      assert.ok(!bobs.servers.some(grant => grant.id === mine.id))
      await assert.rejects(freezer.validate(bob, { ...bobs, servers: [...bobs.servers, { id: mine.id, name: mine.name, revision: mine.revision, ownerId: alice, grantId: null }] }), /mcpUnavailable/)
      await personal.deleteMcp(alice, mine.id)
      assert.deepEqual((await freezer.freeze(alice, workspace)).servers.map(grant => grant.id), [docs.id])
    })

    const tracker = await servers.create(alice, workspace, createWorkspaceMcpSchema.parse({ name: 'Tracker', url: 'https://tracker.example.com/tracker' }))
    const signIn = async (user: string, code: string) => {
      const started = await servers.connect(user, workspace, tracker.id)
      assert.ok(started.authorizationUrl)
      const authorization = new URL(started.authorizationUrl!)
      challenges.add(authorization.searchParams.get('code_challenge')!)
      return servers.callback(user, workspace, tracker.id, { code, state: authorization.searchParams.get('state')! })
    }

    await t.test('"shared" uses only the workspace account, whoever connected it and whoever starts the thread', async () => {
      assert.equal((await servers.check(alice, workspace, tracker.id)).status, 'needs_connect')
      const connected = await signIn(carol, 'code-shared')
      assert.equal(connected.status, 'connected'); assert.equal(connected.authKind, 'oauth'); assert.deepEqual(connected.tools.map(tool => tool.name), ['read', 'write'])
      for (const user of [alice, bob]) {
        const authority = await freezer.freeze(user, workspace)
        assert.ok(!('error' in await call(user, authority, tracker.id)))
        assert.equal(used.at(-1), 'shared')
      }
      // A forged "member" grant on a "shared" server is refused, so no member account is read.
      const authority = await freezer.freeze(bob, workspace)
      await assert.rejects(freezer.validate(bob, { ...authority, servers: authority.servers.map(grant => grant.id === tracker.id ? { ...grant, mode: 'member' as const } : grant) }), /mcpUnavailable/)
    })

    let switched = tracker
    await t.test('"member": each thread uses its starter\'s own account, never another member\'s', async () => {
      const sharedRun = await freezer.freeze(bob, workspace)
      switched = await servers.update(bob, workspace, tracker.id, { connectionMode: 'member' })
      assert.equal(switched.group, 'member'); assert.equal(switched.connected, false)
      // Capy: switching to "Each member" removes the workspace account, and the old run's grant.
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace_mcp_oauth WHERE server_id=$1', [tracker.id])).rows[0].n, 0)
      assert.deepEqual(await call(bob, sharedRun, tracker.id), { error: 'mcpUnavailable' })
      // A starter who has not connected gets no such server in the thread.
      assert.equal((await freezer.freeze(bob, workspace)).servers.some(grant => grant.id === tracker.id), false)
      await signIn(bob, 'code-bob')
      const bobs = await freezer.freeze(bob, workspace)
      assert.deepEqual(bobs.servers.find(grant => grant.id === tracker.id)?.mode, 'member')
      assert.ok(!('error' in await call(bob, bobs, tracker.id)))
      assert.equal(used.at(-1), 'bob')
      // Alice (not connected) gets nothing, and cannot borrow Bob's account with his authority or a forged grant.
      assert.equal((await freezer.freeze(alice, workspace)).servers.some(grant => grant.id === tracker.id), false)
      const before = calls
      assert.deepEqual(await call(alice, bobs, tracker.id), { error: 'mcpUnavailable' })
      assert.deepEqual(await call(alice, { ...bobs, requester: alice, servers: bobs.servers.map(grant => ({ ...grant, ownerId: alice })) }, tracker.id), { error: 'mcpNeedsConnect' })
      assert.deepEqual(await call(alice, { ...bobs, requester: alice }, tracker.id), { error: 'mcpUnavailable' })
      assert.equal(calls, before)
      await signIn(alice, 'code-alice')
      const alices = await freezer.freeze(alice, workspace)
      assert.ok(!('error' in await call(alice, alices, tracker.id)))
      assert.equal(used.at(-1), 'alice')
      assert.ok(!('error' in await call(bob, bobs, tracker.id)))
      assert.equal(used.at(-1), 'bob')
      const detail = await servers.detail(carol, workspace, tracker.id)
      assert.deepEqual(detail.connections.map(entry => entry.userId).sort(), [alice, bob].sort())
      assert.equal(detail.status, 'needs_connect'); assert.equal(detail.connected, false)
      // Disconnect removes only the caller's own account.
      await servers.disconnect(alice, workspace, tracker.id)
      assert.deepEqual(await call(alice, alices, tracker.id), { error: 'mcpNeedsConnect' })
      assert.ok(!('error' in await call(bob, bobs, tracker.id)))
      assert.equal(used.at(-1), 'bob')
      // Back to "Shared": every member's account is removed, and only a workspace account is used.
      switched = await servers.update(alice, workspace, tracker.id, { connectionMode: 'shared' })
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace_mcp_oauth WHERE server_id=$1 AND user_id IS NOT NULL', [tracker.id])).rows[0].n, 0)
      assert.equal((await freezer.freeze(bob, workspace)).servers.some(grant => grant.id === tracker.id), false)
      await signIn(alice, 'code-shared')
      assert.ok(!('error' in await call(bob, await freezer.freeze(bob, workspace), tracker.id)))
      assert.equal(used.at(-1), 'shared')
    })

    await t.test('a removed member loses every server and their own account at once', async () => {
      await servers.update(alice, workspace, tracker.id, { connectionMode: 'member' })
      await signIn(carol, 'code-alice')
      const carols = await freezer.freeze(carol, workspace)
      assert.ok(carols.servers.some(grant => grant.id === tracker.id))
      await pool.query('UPDATE mikka_workspace_members SET status=\'removed\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, carol])
      const before = calls
      for (const id of [tracker.id, docs.id]) assert.match(String((await call(carol, carols, id) as { error?: string }).error), /^(?:mcpUnavailable|workspaceAccessDenied)$/)
      assert.equal(calls, before)
      await assert.rejects(freezer.freeze(carol, workspace), /workspaceAccessDenied/)
      for (const work of [() => servers.list(carol, workspace), () => servers.detail(carol, workspace, tracker.id), () => servers.update(carol, workspace, tracker.id, { enabled: false }),
        () => servers.setTool(carol, workspace, docs.id, 'read', false), () => servers.connect(carol, workspace, tracker.id), () => servers.remove(carol, workspace, docs.id)]) await assert.rejects(work(), /workspaceAccessDenied/)
      assert.ok(!(await servers.detail(alice, workspace, tracker.id)).connections.some(entry => entry.userId === carol))
      // The departure cleanup (releaseDepartingMember) drops their own accounts on this workspace's servers.
      await pool.query('DELETE FROM workspace_mcp_oauth o USING workspace_mcp_servers s WHERE o.server_id=s.id AND s.workspace_id=$1 AND o.user_id=$2', [workspace, carol])
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace_mcp_oauth WHERE user_id=$1', [carol])).rows[0].n, 0)
    })

    await t.test('the claim fence delivers tool switches as it locks them; Enabled, environment and edits are rechecked', async () => {
      const bobs = await freezer.freeze(bob, workspace)
      const assignment = await personal.nativeMcpAssignment(bob, bobs)
      const exported = assignment.servers.find(entry => entry.name === nativeMcpName(docs.id))
      assert.deepEqual(exported && 'disabledTools' in exported ? exported.disabledTools : null, ['write'])
      assert.ok(exported && 'headers' in exported && exported.headers['X-Account'] === 'workspace-account')
      const fence = () => pool.connect().then(async client => {
        try { await client.query('BEGIN'); const locked = await lockNativeMcpAuthority(client, bob, assignment.authority); await client.query('COMMIT'); return locked }
        catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
      })
      assert.deepEqual((await fence())[docs.id], ['write'], 'the fence reads the workspace server\'s own switch table')
      // A switch keeps the revision (running tasks keep the server). The claim is not refused: it
      // delivers the switch as the fence locked it, never the export's older read.
      await servers.setTool(alice, workspace, docs.id, 'write', true)
      const locked = await fence()
      assert.deepEqual(locked[docs.id], [])
      const delivered = withLockedToolSwitches(assignment.servers, locked, true).find(entry => entry.name === nativeMcpName(docs.id))
      assert.deepEqual(delivered && 'disabledTools' in delivered ? delivered.disabledTools : null, [])
      // A switch made while a claim holds the fence waits for that claim to commit.
      const holder = await pool.connect()
      let switched = false
      try {
        await holder.query('BEGIN')
        await lockNativeMcpAuthority(holder, bob, assignment.authority)
        const pending = servers.setTool(alice, workspace, docs.id, 'write', false).then(() => { switched = true })
        await new Promise(resolve => setTimeout(resolve, 300))
        assert.equal(switched, false, 'the switch waits for the claim holding the fence')
        await holder.query('COMMIT')
        await pending
      } finally { holder.release() }
      assert.deepEqual((await fence())[docs.id], ['write'])
      await servers.setTool(alice, workspace, docs.id, 'write', true)
      assert.ok(!('error' in await call(bob, bobs, docs.id, 'write')))
      await servers.setTool(alice, workspace, docs.id, 'write', false)
      assert.deepEqual(await call(bob, bobs, docs.id, 'write'), { error: 'mcpToolDisabled' })
      // Enabled off: no member's threads can use it (Capy), including runs already frozen.
      await servers.update(bob, workspace, docs.id, { enabled: false })
      await assert.rejects(fence(), /mcpUnavailable/)
      assert.equal((await freezer.freeze(bob, workspace)).servers.some(grant => grant.id === docs.id), false)
      await servers.update(bob, workspace, docs.id, { enabled: true })
      // One environment: only that environment's runs.
      await servers.update(bob, workspace, docs.id, { environmentId: environment })
      assert.equal((await freezer.freeze(bob, workspace)).servers.some(grant => grant.id === docs.id), false)
      const scoped = await freezer.freeze(bob, workspace, pool, environment)
      assert.ok(scoped.servers.some(grant => grant.id === docs.id))
      assert.ok(!('error' in await call(bob, scoped, docs.id)))
      await assert.rejects(servers.update(bob, workspace, docs.id, { environmentId: randomUUID() }), /environmentAccessDenied/)
      // A new endpoint drops the saved credential: it never follows a URL to another host.
      const moved = await servers.update(bob, workspace, docs.id, { url: 'https://elsewhere.example.com/docs', environmentId: null })
      assert.equal(moved.authKind, 'none')
      const { rows: [row] } = await pool.query('SELECT auth_header,ciphertext FROM workspace_mcp_servers WHERE id=$1', [docs.id])
      assert.deepEqual(row, { auth_header: null, ciphertext: null })
      assert.deepEqual(await call(bob, scoped, docs.id), { error: 'mcpUnavailable' })
    })
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    const [{ pool: applicationPool }, { workspacePool }] = await Promise.all([import('../db'), import('../workspace-db')])
    await Promise.all([applicationPool.end(), workspacePool.end()])
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await pool.end(); await dropTestDatabase(admin, isolated); await admin.end()
  }
})
