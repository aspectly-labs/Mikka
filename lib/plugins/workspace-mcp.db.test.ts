import { observePoolCommits } from '../db/commit-effects'
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile, readdir } from 'node:fs/promises'
import { Pool } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { isE2eTarget, E2E_DB_RULE } from '../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'
import { isolateCoordinatorWakes } from '../../tests/support/coordinator-wake'
import { PersonalPluginStore } from './store'
import { McpConnectionStore } from './connection-store'
import { lockNativeMcpAuthority, WorkspaceMcpStore } from './workspace-mcp'
import { createMcpSchema, type McpAuthority } from './contracts'
import { withLockedToolSwitches } from './native-mcp'
import { createPersonalMcpRuntime, type McpDependencies } from './mcp'
import { AgentKitStore } from '@/lib/agent-kit/store'
import { DEFAULT_AGENT_DEFINITION } from '@/lib/agent-kit/builtin'
import { freezeWorkerDefinition, retryWorkerDefinition } from '@/lib/agent-kit/worker'
import { freezeExecutionIdentity, ExecutionIdentityError } from '@/lib/execution-identity'
import { createExecutionClaim } from '../../tests/helpers/factory-execution-claim'

mock.module(new URL('../coordinator/decide.ts', import.meta.url).href, { namedExports: { invokeDecision: async () => null } })

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(isE2eTarget(url), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail('Personal MCP tests require an isolated E2E_DATABASE_URL')

// The migration that withdrew every workspace grant (decision 2026-11-27-1700).
const RETIRE_SHARES = '20261127170034_retire_personal_mcp_workspace_shares.sql'

test('a personal MCP server serves its owner only; retired workspace grants admit nothing', { skip: !url, timeout: 180_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const database = `workspace_mcp_${randomUUID().replaceAll('-', '')}_e2e`
  await createTestDatabase(admin, database, 'template0')
  const target = new URL(url!); target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.toString(), max: 5 })
  observePoolCommits(pool)
  let appPool: Pool | undefined, workspacePool: Pool | undefined
  const saved = { MIKKA_DATABASE_URL: process.env.MIKKA_DATABASE_URL, DATABASE_URL: process.env.DATABASE_URL, WORKSPACE_SECRETS_KEY: process.env.WORKSPACE_SECRETS_KEY }
  Object.assign(process.env, { MIKKA_DATABASE_URL: target.toString(), DATABASE_URL: target.toString(), WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') })
  const wakes = await isolateCoordinatorWakes(t)
  const secret = `synthetic-mcp-${randomUUID()}`, privateUrl = 'https://mcp.acme.dev/private-endpoint'
  let calls = 0, handshakes = 0, afterInitialize: (() => Promise<void>) | undefined
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${secret}`)
    if (request.method === 'DELETE') { response.writeHead(200); response.end(); return }
    if (request.method === 'GET') { response.writeHead(405); response.end(); return }
    let body = ''; for await (const chunk of request) body += chunk
    const input = JSON.parse(body)
    if (!('id' in input)) { response.writeHead(202); response.end(); return }
    if (input.method === 'initialize') { handshakes++; await afterInitialize?.() }
    if (input.method === 'tools/call') calls++
    const result = input.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'owner-fixture', version: '1' } }
      : input.method === 'tools/list' ? { tools: [{ name: 'echo', description: `${privateUrl} ${secret}`, inputSchema: { type: 'object', properties: {} } }] }
        : { content: [{ type: 'text', text: JSON.stringify({ done: true, secret, authorization: `Bearer ${secret}`, encoded: Buffer.from(secret).toString('base64'), endpoint: privateUrl }) }] }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  // A real MCP SDK handshake against a local fixture; no third-party service or model I/O.
  const transport: McpDependencies = { transport: (_origin, signal) => ({ fetch: (input, init) => fetch(address + new URL(String(input)).pathname, { ...init, signal }), close: async () => {} }) }
  try {
    const directory = new URL('../../drizzle/', import.meta.url)
    const migrations = orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql')))
    assert.ok(migrations.includes(RETIRE_SHARES))
    // Every migration before the retirement: the database as production had it, grants included.
    for (const migration of migrations.filter(name => name !== RETIRE_SHARES)) await pool.query(await readFile(new URL(migration, directory), 'utf8'))
    mock.module('@/lib/server-runtime/server', { namedExports: { after() {} } })
    const { issueRunToken, verifyRunToken } = await import('@/lib/mcp/worker')
    const { runMcpAuthority, runCustomMcp } = await import('./run-mcp')
    const { releaseDepartingMember } = await import('@/lib/workspace-admin/members')
    appPool = (await import('@/lib/db')).pool; workspacePool = (await import('@/lib/workspace-db')).workspacePool
    const owner = 'mcp-owner', peer = 'mcp-peer', outsider = 'mcp-outsider'
    for (const user of [owner, peer, outsider]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [user, `${user}@example.invalid`])
    const workspace = randomUUID(), personalWorkspace = randomUUID()
    for (const [id, kind] of [[workspace, 'team'], [personalWorkspace, 'personal']]) {
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,\'MCP fixture\',$3)', [id, owner, kind])
      for (const user of kind === 'personal' ? [owner] : [owner, peer]) await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'member\',\'active\')', [id, user, `${user}@example.invalid`])
    }
    // Each person has their own Bot, computer, Agent and task.
    const fixtures = Object.fromEntries(await Promise.all([owner, peer].map(async user => {
      const ids = { bot: randomUUID(), device: randomUUID(), agent: randomUUID(), issue: randomUUID() }
      await pool.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,\'Fixture Bot\')', [ids.bot, user, workspace])
      await pool.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,\'Fixture device\')', [ids.device, user])
      await pool.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,\'Fixture Agent\',\'codex\',$3)', [ids.agent, user, ids.device])
      await pool.query('INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority) VALUES($1,$2,$3,\'MCP fixture\',\'{"type":"doc","content":[]}\',\'doing\',\'normal\')', [ids.issue, user, workspace])
      return [user, ids] as const
    })))
    const personal = new PersonalPluginStore(pool, process.env, pool), servers = new WorkspaceMcpStore(pool, pool)
    const connection = await personal.createMcp(owner, createMcpSchema.parse({ name: 'Team finance', url: privateUrl, auth: { name: 'Authorization', value: `Bearer ${secret}` } }))
    const runtime = createPersonalMcpRuntime(personal, transport)
    const command = { serverId: connection.id, name: 'echo', arguments: {} }
    const insertRun = async (user: string, definition: unknown, status = 'queued') => {
      const id = randomUUID(), f = fixtures[user]
      await pool.query('INSERT INTO agent_runs(id,"userId","botId","deviceId","agentId","issueId",status,"agentDefinition","workspaceId") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, user, f.bot, f.device, f.agent, f.issue, status, definition === null ? null : JSON.stringify(definition), workspace])
      return id
    }

    // Before the deploy: the owner had shared the server, and a teammate's run was admitted with it.
    const grantId = randomUUID()
    await pool.query('INSERT INTO personal_mcp_workspace_shares(id,server_id,workspace_id) VALUES($1,$2,$3)', [grantId, connection.id, workspace])
    const formerlyShared: McpAuthority = { requester: peer, workspaceId: workspace, servers: [{ id: connection.id, name: connection.name, revision: connection.revision, ownerId: owner, grantId }] }
    const legacySnapshot = { servers: [{ id: connection.id, name: connection.name, revision: connection.revision }], skills: [], mcpAuthority: formerlyShared }
    const legacyRun = await insertRun(peer, { harness: 'codex', instructions: 'Peer task', prompt: 'Use the team resource', customMcp: formerlyShared }, 'running')
    const ownRun = await insertRun(owner, { harness: 'codex', instructions: 'Owner task', prompt: 'Own resource', customMcp: await servers.freeze(owner, workspace) }, 'running')

    await t.test('the migration withdraws every grant, refuses new ones, stops runs holding another person\'s server and is idempotent', async () => {
      const retire = await readFile(new URL(RETIRE_SHARES, directory), 'utf8')
      await pool.query(retire)
      assert.equal((await pool.query('SELECT 1 FROM personal_mcp_workspace_shares')).rowCount, 0)
      await assert.rejects(pool.query('INSERT INTO personal_mcp_workspace_shares(id,server_id,workspace_id) VALUES($1,$2,$3)', [randomUUID(), connection.id, workspace]),
        (error: { code?: string }) => error.code === '23514', 'an old build still serving during the rollout cannot share again')
      const stopped = async (id: string) => (await pool.query<{ stopped: boolean }>('SELECT "stopRequestedAt" IS NOT NULL AS stopped FROM agent_runs WHERE id=$1', [id])).rows[0].stopped
      assert.equal(await stopped(legacyRun), true, 'a native task machine already holding the owner credential is stopped')
      assert.equal(await stopped(ownRun), false, 'a run on its requester\'s own server keeps going')
      await pool.query(retire)
      assert.equal(await stopped(ownRun), false)
    })

    await t.test('a member neither sees nor receives another person\'s server, in any workspace', async () => {
      for (const id of [workspace]) {
        const page = await servers.list(peer, id)
        assert.deepEqual({ canShare: page.canShare, servers: page.servers }, { canShare: false, servers: [] })
        assert.equal((await personal.snapshot(peer, pool, id)).servers.length, 0)
        assert.deepEqual((await servers.freeze(peer, id)).servers, [])
      }
      await assert.rejects(servers.list(outsider, workspace), /workspaceAccessDenied/)
      await assert.rejects(personal.mcpConnection(peer, connection.id), /mcpUnavailable/)
      await assert.rejects(new McpConnectionStore(personal).detail(peer, connection.id, workspace), /mcpNotFound/)
      assert.equal((await new McpConnectionStore(personal).search(peer, { workspaceId: workspace })).count, 0)
      assert.equal(handshakes, 0)
    })

    await t.test('a run admitted with a formerly shared server fails closed on its next call, claim and identity check', async () => {
      const before = { calls, handshakes }
      assert.deepEqual(await runtime(peer, legacySnapshot, command), { error: 'mcpUnavailable' })
      assert.deepEqual(await runtime(peer, legacySnapshot, { serverId: connection.id }), { error: 'mcpUnavailable' })
      // Forged references: the owner's server without the grant, or the owner's own reference with one.
      for (const authority of [{ ...formerlyShared, servers: formerlyShared.servers.map(grant => ({ ...grant, grantId: null })) },
        { ...formerlyShared, requester: owner }, { ...formerlyShared, requester: owner, servers: formerlyShared.servers.map(grant => ({ ...grant, ownerId: owner })) }]) {
        assert.ok('error' in await runtime(authority.requester, { ...legacySnapshot, mcpAuthority: authority }, command))
        await assert.rejects(personal.nativeMcpConnections(authority.requester, authority), /mcpUnavailable/)
      }
      await assert.rejects(personal.nativeMcpConnections(peer, formerlyShared), /mcpUnavailable/)
      const client = await pool.connect()
      try { await client.query('BEGIN'); await assert.rejects(lockNativeMcpAuthority(client, peer, formerlyShared), /mcpUnavailable/) }
      finally { await client.query('ROLLBACK'); client.release() }
      const definition = { harness: 'codex', instructions: 'Peer task', prompt: 'Use the team resource', customMcp: formerlyShared } as never
      await assert.rejects(freezeExecutionIdentity(pool, { userId: peer, botId: fixtures[peer].bot, deviceId: fixtures[peer].device, agentDefinition: definition }, pool), ExecutionIdentityError)
      const { token } = await issueRunToken({ id: legacyRun, userId: peer })
      const verified = await verifyRunToken(new Request('http://127.0.0.1/mikka/api/runs/mcp/custom_mcp'), token)
      if (verified) assert.ok('error' in await runCustomMcp(new Request('http://127.0.0.1/mikka/api/runs/mcp/custom_mcp'), verified, command, transport))
      assert.deepEqual({ calls, handshakes }, before, 'no credential was used and no server was contacted')
    })

    await t.test('the code no longer reads grants: a stray grant row lends nothing', async () => {
      const before = { calls, handshakes }
      await pool.query('ALTER TABLE personal_mcp_workspace_shares DROP CONSTRAINT personal_mcp_workspace_shares_retired')
      await pool.query('INSERT INTO personal_mcp_workspace_shares(id,server_id,workspace_id) VALUES($1,$2,$3)', [grantId, connection.id, workspace])
      try {
        assert.deepEqual((await servers.list(peer, workspace)).servers, [])
        assert.deepEqual((await servers.freeze(peer, workspace)).servers, [])
        assert.deepEqual(await runtime(peer, legacySnapshot, command), { error: 'mcpUnavailable' })
        await assert.rejects(personal.nativeMcpConnections(peer, formerlyShared), /mcpUnavailable/)
      } finally {
        await pool.query(await readFile(new URL(RETIRE_SHARES, directory), 'utf8'))
      }
      assert.equal((await pool.query('SELECT 1 FROM personal_mcp_workspace_shares')).rowCount, 0)
      assert.deepEqual({ calls, handshakes }, before)
    })

    const kit = new AgentKitStore(pool), scope = { ownerId: owner, botId: fixtures[owner].bot, workspaceId: workspace }
    const execution = await kit.beginExecution(scope, 'owner-mcp-execution', 'Owner instructions only', { harness: 'ai_sdk', model: 'fixture-no-model-call' }, DEFAULT_AGENT_DEFINITION, client => personal.snapshot(owner, client, workspace))
    const definition = freezeWorkerDefinition({ harness: 'codex', instructions: 'Owner task', prompt: 'Read my own resource', parent: execution.snapshot, executionId: execution.id, allowLocalRecovery: true })
    definition.executionIdentity = await freezeExecutionIdentity(pool, { userId: owner, botId: fixtures[owner].bot, deviceId: fixtures[owner].device, agentDefinition: definition }, pool)
    const runId = await insertRun(owner, definition), request = new Request('http://127.0.0.1/mikka/api/runs/mcp/custom_mcp')
    const { token } = await issueRunToken({ id: runId, userId: owner })
    const verified = await verifyRunToken(request, token); assert.ok(verified)
    const claim = createExecutionClaim(pool, async () => true)
    await claim(owner, fixtures[owner].device, runId, new Date(Date.now() + 300_000).toISOString())
    let snapshot = await personal.snapshot(owner, pool, workspace)

    await t.test('the owner\'s own runs keep working in a team workspace, without leaking the credential', async () => {
      const page = await servers.list(owner, workspace)
      assert.equal(page.canShare, false)
      assert.deepEqual(page.servers.map(({ id, url, mine, shared, ownerId }) => ({ id, url, mine, shared, ownerId })), [{ id: connection.id, url: privateUrl, mine: true, shared: false, ownerId: owner }])
      assert.deepEqual(snapshot.mcpAuthority?.servers, [{ id: connection.id, name: connection.name, revision: connection.revision, ownerId: owner, grantId: null }])
      const catalog = await runtime(owner, snapshot, { serverId: connection.id })
      const result = await runtime(owner, snapshot, command)
      assert.equal(calls, 1); assert.ok('tools' in catalog)
      for (const value of [catalog, result]) for (const needle of [secret, Buffer.from(secret).toString('base64'), privateUrl]) assert.ok(!JSON.stringify(value).includes(needle))
      assert.equal((await runtime(owner, await personal.snapshot(owner), command) as { error?: string }).error, undefined, 'the personal runtime outside a workspace stays usable')
      assert.deepEqual(definition.executionIdentity?.resourceBindings.find(item => item.kind === 'mcp'),
        { kind: 'mcp', id: connection.id, ownerId: owner, access: 'owner', revision: String(connection.revision), workspaceId: workspace })
      assert.equal((await runMcpAuthority(owner, runId))?.servers[0].ownerId, owner)
      assert.ok(!('error' in await runCustomMcp(request, verified, command, transport)))
      assert.equal((await personal.nativeMcpConnections(owner, snapshot.mcpAuthority!)).length, 1)
      assert.deepEqual(retryWorkerDefinition(definition, 'Retry current target')?.customMcp, definition.customMcp)
    })

    await t.test('a teammate\'s message in the owner\'s thread still runs on the thread starter\'s servers, never the sender\'s', async () => {
      await pool.query(`UPDATE resource_access_policies SET visibility='shared' WHERE kind='thread' AND id=$1`, [runId])
      // The peer's own server: it must never reach the owner's thread.
      const peerConnection = await personal.createMcp(peer, createMcpSchema.parse({ name: 'Peer notes', url: 'https://mcp.acme.dev/peer', auth: { name: 'Authorization', value: 'Bearer peer-only' } }))
      const { sendToThread } = await import('@/lib/interop/threads')
      const sent = await sendToThread({ kind: 'account', userId: peer, workspaceId: workspace }, { runId, text: 'Please check the finance numbers', key: 'peer-message-1' })
      assert.deepEqual(sent, { runId, continued: false }, 'a working thread takes the message on its own run')
      const authority = await runMcpAuthority(owner, runId)
      assert.deepEqual(authority?.servers.map(grant => [grant.id, grant.ownerId]), [[connection.id, owner]])
      assert.equal(await runMcpAuthority(peer, runId), null, 'the sender does not become the run\'s requester')
      const before = calls
      assert.ok(!('error' in await runCustomMcp(request, verified, command, transport)))
      assert.equal(calls, before + 1)
      assert.ok('error' in await runCustomMcp(request, verified, { serverId: peerConnection.id, name: 'echo', arguments: {} }, transport), 'the sender\'s server is not offered in the owner\'s thread')
      // In the peer's own thread, the peer's servers and never the owner's.
      const peerAuthority = await servers.freeze(peer, workspace)
      assert.deepEqual(peerAuthority.servers.map(grant => [grant.id, grant.ownerId]), [[peerConnection.id, peer]])
      await personal.deleteMcp(peer, peerConnection.id)
      await pool.query(`UPDATE resource_access_policies SET visibility='private' WHERE kind='thread' AND id=$1`, [runId])
    })

    await t.test('token withdrawal during the MCP handshake refuses the side effect', async () => {
      const before = calls
      afterInitialize = async () => { await pool.query('UPDATE run_tokens SET "revokedAt"=now() WHERE "runId"=$1', [runId]) }
      assert.deepEqual(await runCustomMcp(request, verified, command, transport), { error: 'mcpUnavailable' })
      afterInitialize = undefined
      assert.equal(calls, before)
      await pool.query('UPDATE run_tokens SET "revokedAt"=NULL WHERE "runId"=$1', [runId])
    })

    await t.test('the locked native claim fence returns the switches current at commit and rejects a committed connection edit', async () => {
      const before = await personal.snapshot(owner, pool, workspace)
      assert.ok(before.mcpAuthority?.servers.length)
      const frozen = before.mcpAuthority
      const fence = async (authority: typeof frozen) => {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          return await lockNativeMcpAuthority(client, owner, authority)
        } finally {
          await client.query('ROLLBACK')
          client.release()
        }
      }
      const assign = () => personal.nativeMcpAssignment(owner, frozen)
      const listed = (servers: { disabledTools?: string[] }[]) => servers.flatMap(server => server.disabledTools ?? [])
      assert.deepEqual(await fence(frozen), { [connection.id]: [] })

      const connections = new McpConnectionStore(personal)
      await pool.query('INSERT INTO mcp_server_tools(server_id,tool_name) VALUES($1,$2) ON CONFLICT DO NOTHING', [connection.id, 'echo'])
      // The export reads the switches before the claim locks them. A switch in between is not a
      // refusal (that left the run leased and stranded): the claim response takes the list the
      // fence read under lock, so the same claim delivers the current one.
      const exported = await assign()
      assert.deepEqual(listed(exported.servers), [])
      await connections.setTool(owner, connection.id, 'echo', false)
      const locked = await fence(exported.authority)
      assert.deepEqual(locked, { [connection.id]: ['echo'] })
      assert.deepEqual(listed(withLockedToolSwitches(exported.servers, locked, true)), ['echo'])
      // Fail closed: a daemon that cannot filter tools, or a server the fence did not lock, is unavailable.
      assert.throws(() => withLockedToolSwitches(exported.servers, locked, false), /mcpUnavailable/)
      assert.throws(() => withLockedToolSwitches(exported.servers, {}, true), /mcpUnavailable/)
      // Turning it back on is delivered the same way.
      const stale = await assign()
      assert.deepEqual(listed(stale.servers), ['echo'])
      await connections.setTool(owner, connection.id, 'echo', true)
      assert.deepEqual(listed(withLockedToolSwitches(stale.servers, await fence(stale.authority), true)), [])

      // A switch made while a claim holds the fence waits for that claim to commit.
      const claim = await pool.connect()
      try {
        await claim.query('BEGIN')
        assert.deepEqual(await lockNativeMcpAuthority(claim, owner, frozen), { [connection.id]: [] })
        let switched = false
        const waiting = connections.setTool(owner, connection.id, 'echo', false).then(() => { switched = true })
        await new Promise(resolve => setTimeout(resolve, 300))
        assert.equal(switched, false)
        await claim.query('COMMIT')
        await waiting
        assert.equal(switched, true)
      } finally { claim.release() }
      assert.deepEqual(await fence(frozen), { [connection.id]: ['echo'] })
      await connections.setTool(owner, connection.id, 'echo', true)

      // A real connection edit still revokes an export taken before it.
      const beforeRename = await assign()
      const renamed = await personal.updateMcp(owner, { id: connection.id, name: 'Renamed connection' })
      await assert.rejects(fence(beforeRename.authority), /mcpUnavailable/)
      await personal.updateMcp(owner, { id: connection.id, name: frozen.servers.find(server => server.id === connection.id)!.name })
      assert.ok(renamed.revision > frozen.servers.find(server => server.id === connection.id)!.revision)
      snapshot = await personal.snapshot(owner, pool, workspace)
      assert.ok(snapshot.mcpAuthority?.servers.length)
      await fence(snapshot.mcpAuthority)
    })

    await t.test('disconnect/revision changes and the owner\'s departure revoke workspace references', async () => {
      const before = calls
      await personal.updateMcp(owner, { id: connection.id, enabled: false })
      assert.ok('error' in await runtime(owner, snapshot, command)); assert.equal(calls, before)
      await personal.updateMcp(owner, { id: connection.id, enabled: true })
      assert.ok('error' in await runtime(owner, snapshot, command))
      snapshot = await personal.snapshot(owner, pool, workspace)
      await releaseDepartingMember(workspace, owner)
      await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, owner])
      assert.ok('error' in await runtime(owner, snapshot, command)); assert.equal(calls, before)
      assert.equal((await runtime(owner, await personal.snapshot(owner), command) as { error?: string }).error, undefined, 'outside the workspace the server stays the owner\'s')
    })
  } finally {
    await wakes.flush()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await (await import('../builtin-gateway/runtime')).builtinGateway()?.stop()
    await dropTestDatabase(admin, database, pool, appPool, workspacePool)
  }
})
