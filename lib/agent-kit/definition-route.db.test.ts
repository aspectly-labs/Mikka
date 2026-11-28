import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createServer, IncomingMessage } from 'node:http'
import { registerHooks } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import test, { mock } from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { apiAliases } from '../../apps/api/compat-aliases.mjs'
import type { ApiRoute } from '../../apps/api/src/routes'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'

const target = process.env.E2E_DATABASE_URL
const available = Boolean(target && disposableDatabase(process.env, target))
if (process.env.REQUIRE_DB === '1' && !available) throw new Error('Definition HTTP acceptance requires an isolated loopback *_e2e database')

type Observation = { authReads: number; sessionSelects: number; userSelects: number; scopeReads: number; afterScopeRead?: () => Promise<void> }

test('definition HTTP reuses request admission and preserves fresh revocation checks on PostgreSQL 17', { skip: !available, timeout: 120_000 }, async t => {
  const admin = new Pool({ connectionString: target, max: 1 })
  const database = `definition_entry_${randomUUID().replaceAll('-', '')}_e2e`
  await createTestDatabase(admin, database, 'template0')
  const url = new URL(target!); url.pathname = '/' + database
  const controls = new Pool({ connectionString: url.toString(), max: 2 })
  const appPool = new Pool({ connectionString: url.toString(), max: 5 })
  const workspacePool = new Pool({ connectionString: url.toString(), max: 5 })
  const globals = globalThis as unknown as { mikkaPool?: Pool; workspacePool?: Pool }
  const previousPools = { app: globals.mikkaPool, workspace: globals.workspacePool }
  const environment: Record<string, string | undefined> = {
    E2E_DATABASE_URL: url.toString(), MIKKA_DATABASE_URL: url.toString(), DATABASE_URL: url.toString(), ORVILO_DATABASE_URL: url.toString(),
    BETTER_AUTH_URL: undefined, BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex'),
    MIKKA_BASE_PATH: '/mikka', MIKKA_EDITION: 'community', MIKKA_TEST_MODE: '1', NODE_ENV: 'test',
    MIKKA_PUBLIC_POSTHOG_KEY: '', NEXT_PUBLIC_POSTHOG_KEY: '', MIKKA_TRACE_SAMPLE_RATE: '0',
  }
  const previousEnvironment = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]))
  for (const [name, value] of Object.entries(environment)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  globals.mikkaPool = appPool; globals.workspacePool = workspacePool
  const aliases = apiAliases as Record<string, string>
  const loader = registerHooks({ resolve(specifier, context, next) {
    const mapped = specifier === '@' ? undefined : aliases[specifier]
    return next(mapped ? pathToFileURL(mapped).href : specifier, context)
  } })
  let closeHTTP: (() => Promise<void>) | undefined
  t.after(async () => {
    await closeHTTP?.()
    mock.restoreAll(); loader.deregister()
    globals.mikkaPool = previousPools.app; globals.workspacePool = previousPools.workspace
    await dropTestDatabase(admin, database, controls, appPool, workspacePool)
    await admin.end()
    for (const [name, value] of Object.entries(previousEnvironment)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  })
  assert.equal(Math.floor(Number((await controls.query('SHOW server_version_num')).rows[0].server_version_num) / 10000), 17)
  const migrations = new URL('../../drizzle/', import.meta.url)
  for (const name of orderMigrations((await readdir(migrations)).filter(name => name.endsWith('.sql'))))
    await controls.query(await readFile(new URL(name, migrations), 'utf8'))

  // Observe only query categories. Every original SQL statement and auth call
  // still executes; the race hook changes real database state after scope I/O.
  const active = new AsyncLocalStorage<Observation>()
  for (const pool of [appPool, workspacePool]) pool.on('connect', (client: PoolClient) => {
    const query = client.query
    client.query = function (this: PoolClient, ...args: unknown[]) {
      const input = args[0] as string | { text?: string }
      const sql = typeof input === 'string' ? input : input?.text ?? ''
      const observation = active.getStore()
      if (observation && /^\s*select\b/i.test(sql)) {
        if (/\bfrom\s+"?session"?(?:\s|$)/i.test(sql)) observation.sessionSelects++
        if (/\bfrom\s+"?user"?(?:\s|$)/i.test(sql)) observation.userSelects++
      }
      if (observation && /^select "status" from "mikka_workspace_members"/i.test(sql)) {
        observation.scopeReads++
        const hook = observation.afterScopeRead
        observation.afterScopeRead = undefined
        if (hook) {
          // pg-pool uses client.query(callback), while direct clients can use
          // its Promise overload. Preserve both and complete each read once.
          const callback = args.at(-1)
          if (typeof callback === 'function') {
            const forwarded = (...values: unknown[]) => {
              if (values[0]) return Reflect.apply(callback, this, values)
              void Promise.resolve().then(hook).then(
                () => Reflect.apply(callback, this, values),
                error => Reflect.apply(callback, this, [error, values[1]]),
              )
            }
            return Reflect.apply(query, this, [...args.slice(0, -1), forwarded])
          }
          return Reflect.apply(query, this, args).then(async (value: unknown) => { await hook(); return value })
        }
      }
      return Reflect.apply(query, this, args)
    } as typeof client.query
  })
  const { createApiHandler } = await import('../../apps/api/src/application')
  const { serve } = await import('srvx/node')
  const route: ApiRoute = { path: '/mikka/api/bots/[botId]/definition', template: '/api/bots/[botId]/definition',
    source: 'app/api/bots/[botId]/definition/route.ts', methods: ['GET', 'POST'],
    load: () => import('../../app/api/bots/[botId]/definition/route') }
  const application = createApiHandler([route])
  const observations = new Map<string, Observation>()
  const hooks = new Map<string, Observation['afterScopeRead']>()
  const runtime = serve({ manual: true, gracefulShutdown: false, silent: true, trustProxy: false, hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      assert.ok(request.runtime?.node?.req instanceof IncomingMessage)
      const id = request.headers.get('x-fixture-request-id')!
      const observation: Observation = { authReads: 0, sessionSelects: 0, userSelects: 0, scopeReads: 0, afterScopeRead: hooks.get(id) }
      observations.set(id, observation)
      return active.run(observation, () => application.fetch(request))
    },
  })
  const server = createServer(runtime.node!.handler)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  process.env.BETTER_AUTH_URL = origin
  closeHTTP = async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await runtime.close()
  }
  const { auth: provider } = await import('../auth')
  const api = await import('../api-auth')
  const originalAuth = api.auth.api.getSession
  mock.method(api.auth.api, 'getSession', async (options: Parameters<typeof originalAuth>[0]) => {
    const observation = active.getStore()
    if (observation) { observation.authReads++; assert.equal(options.query?.disableCookieCache, true) }
    return originalAuth(options)
  })
  const auth = await provider.$context
  const session = async (userId: string) => {
    const row = await auth.internalAdapter.createSession(userId); assert.ok(row)
    const signature = createHmac('sha256', auth.secret).update(row.token).digest('base64')
    return { id: row.id, cookie: auth.authCookies.sessionToken.name + '=' + encodeURIComponent(row.token + '.' + signature) }
  }
  const person = async (label: string) => {
    const userId = `definition-${label}-${randomUUID()}`, workspaceId = randomUUID(), botId = randomUUID()
    await controls.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [userId, userId + '@example.invalid'])
    await controls.query('INSERT INTO mikka_workspaces (id,"userId",name) VALUES ($1,$2,\'Definition fixture\')', [workspaceId, userId])
    await controls.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'admin\',\'active\')', [workspaceId, userId, userId + '@example.invalid'])
    await controls.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,\'Definition fixture\')', [botId, userId, workspaceId])
    return { userId, workspaceId, botId, session: await session(userId) }
  }
  const alpha = await person('alpha'), beta = await person('beta')
  const call = async (botId: string, headers: HeadersInit = {}, body?: unknown, afterScopeRead?: Observation['afterScopeRead']) => {
    const id = randomUUID(), input = new Headers(headers)
    input.set('x-fixture-request-id', id); input.set('content-type', 'application/json')
    if (!input.has('origin')) input.set('origin', origin)
    if (afterScopeRead) hooks.set(id, afterScopeRead)
    try {
      const response = await fetch(`${origin}/mikka/api/bots/${botId}/definition`, { method: body === undefined ? 'GET' : 'POST', headers: input,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const value = await response.json()
      const observation = observations.get(id); assert.ok(observation)
      return { status: response.status, headers: response.headers, body: value, observation }
    } finally { hooks.delete(id); observations.delete(id) }
  }
  const credentials = (person: typeof alpha) => ({ cookie: person.session.cookie })
  const versionCount = async (userId: string) => Number((await controls.query('SELECT count(*) FROM agent_kit_versions WHERE owner_id=$1', [userId])).rows[0].count)

  await t.test('GET executes one admission read and one post-scope revocation read', async () => {
    const result = await call(alpha.botId, credentials(alpha))
    assert.equal(result.status, 200); assert.equal(result.body.version, 1)
    assert.equal(result.headers.get('cache-control'), 'private, no-store')
    t.diagnostic(JSON.stringify({ operation: 'GET', authReads: result.observation.authReads, sessionSelects: result.observation.sessionSelects, userSelects: result.observation.userSelects }))
    assert.equal(result.observation.scopeReads, 1)
    assert.equal(result.observation.authReads, 2)
    assert.equal(result.observation.sessionSelects, 2)
    assert.equal(result.observation.userSelects, 2)
  })
  await t.test('POST persists the exact version with the same bounded session reads', async () => {
    const current = await call(alpha.botId, credentials(alpha)); assert.equal(current.status, 200)
    const result = await call(alpha.botId, credentials(alpha), { action: 'save', definition: { ...current.body.definition, instructions: 'Alpha retained definition' }, expectedVersion: current.body.version, requestId: randomUUID() })
    assert.equal(result.status, 200)
    const retained = await call(alpha.botId, credentials(alpha))
    assert.equal(retained.body.id, result.body.id); assert.equal(retained.body.definition.instructions, 'Alpha retained definition')
    t.diagnostic(JSON.stringify({ operation: 'POST', authReads: result.observation.authReads, sessionSelects: result.observation.sessionSelects, userSelects: result.observation.userSelects }))
    assert.equal(result.observation.authReads, 2)
    assert.equal(result.observation.sessionSelects, 2)
    assert.equal(result.observation.userSelects, 2)
  })
  await t.test('missing/revoked sessions, another owner and a foreign origin remain refused', async () => {
    assert.equal((await call(alpha.botId)).status, 401)
    assert.equal((await call(alpha.botId, credentials(beta))).status, 404)
    const revoked = await session(alpha.userId)
    await controls.query('DELETE FROM session WHERE id=$1', [revoked.id])
    assert.equal((await call(alpha.botId, { cookie: revoked.cookie })).status, 401)
    const before = await versionCount(alpha.userId)
    const rejected = await call(alpha.botId, { ...credentials(alpha), origin: 'https://foreign.invalid' }, { action: 'save' })
    assert.equal(rejected.status, 403); assert.equal(rejected.observation.authReads, 0)
    assert.equal(await versionCount(alpha.userId), before)
  })
  await t.test('a session revoked during real scope I/O is refused before any definition write', async () => {
    const retained = await call(alpha.botId, credentials(alpha)), revocable = await session(alpha.userId)
    const before = await versionCount(alpha.userId)
    const result = await call(alpha.botId, { cookie: revocable.cookie }, { action: 'save', definition: retained.body.definition,
      expectedVersion: retained.body.version, requestId: randomUUID() }, async () => {
      await controls.query('DELETE FROM session WHERE id=$1', [revocable.id])
    })
    assert.equal(result.observation.scopeReads, 1)
    assert.equal(result.status, 404)
    assert.equal(await versionCount(alpha.userId), before)
  })
  await t.test('a suspended workspace member is refused by the real scope lookup', async () => {
    await controls.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha.workspaceId, alpha.userId])
    try { assert.equal((await call(alpha.botId, credentials(alpha))).status, 404) }
    finally { await controls.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha.workspaceId, alpha.userId]) }
  })
  await t.test('overlapping requests retain each authenticated owner through awaited scope work', async () => {
    const first = await call(beta.botId, credentials(beta))
    assert.equal((await call(beta.botId, credentials(beta), { action: 'save', definition: { ...first.body.definition, instructions: 'Beta retained definition' }, expectedVersion: first.body.version, requestId: randomUUID() })).status, 200)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const pending = call(alpha.botId, credentials(alpha), undefined, async () => { entered.resolve(); await release.promise })
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('Scope checkpoint was not reached') })])
      const second = await call(beta.botId, credentials(beta))
      assert.equal(second.status, 200); assert.equal(second.body.definition.instructions, 'Beta retained definition')
    } finally { release.resolve(); await pending }
    const result = await pending
    assert.equal(result.status, 200); assert.equal(result.body.definition.instructions, 'Alpha retained definition')
  })
  await t.test('PAT workspace and post-scope revocation fences stay authoritative', async () => {
    const { createLegacyPersonalAccessToken } = await import('../tokens/store')
    const token = await createLegacyPersonalAccessToken(alpha.userId, alpha.workspaceId, { name: 'Definition fixture' })
    const headers = { authorization: 'Bearer ' + token.token }
    assert.equal((await call(alpha.botId, headers)).status, 200)
    const workspaceId = randomUUID(), botId = randomUUID()
    await controls.query('INSERT INTO mikka_workspaces (id,"userId",name) VALUES ($1,$2,\'Other definition fixture\')', [workspaceId, alpha.userId])
    await controls.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'admin\',\'active\')', [workspaceId, alpha.userId, alpha.userId + '@example.invalid'])
    await controls.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,\'Other definition fixture\')', [botId, alpha.userId, workspaceId])
    assert.equal((await call(botId, headers)).status, 404)
    const revoked = await call(alpha.botId, headers, undefined, async () => {
      await controls.query('UPDATE personal_access_tokens SET "revokedAt"=now() WHERE id=$1', [token.id])
    })
    assert.equal(revoked.observation.scopeReads, 1); assert.equal(revoked.status, 404)
  })
})
