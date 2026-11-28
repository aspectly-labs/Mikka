import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { assertE2eTarget } from '../../tests/helpers/e2e-target.mjs'

const target = process.env.E2E_DATABASE_URL
if (target) {
  assertE2eTarget(target)
  assert.equal(process.env.MIKKA_DATABASE_URL, target)
  assert.equal(process.env.DATABASE_URL, target)
}
if (!target && process.env.REQUIRE_DB === '1') throw Error('An isolated web-rate database is required')

test('cold web services share the existing 10/user/min gate before actual Firecrawl HTTP', { skip: !target }, async t => {
  const schema = `web_rate_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: target, max: 1 })
  await admin.query(`CREATE SCHEMA ${schema}`)
  await admin.query(`CREATE TABLE ${schema}."rateLimit" (LIKE public."rateLimit" INCLUDING ALL)`)
  const connection = new URL(target!)
  connection.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: connection.toString(), max: 2 })
  const { createRequestDatabaseScope, pool: appPool } = await import('../db')
  const scope = createRequestDatabaseScope(connection.toString())
  const originalFetch = globalThis.fetch, priorKey = process.env.FIRECRAWL_API_KEY
  const hits: string[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const part of request) chunks.push(Buffer.from(part))
    const input = JSON.parse(Buffer.concat(chunks).toString())
    hits.push(input.query)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({success:true,data:{web:[{url:'https://example.invalid/public',title:'Public fixture',description:'Isolated provider response'}]}}))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`
  process.env.FIRECRAWL_API_KEY = 'isolated-web-rate-fixture-only'
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), 'https://api.firecrawl.dev/v2/search', 'No external provider or scrape request may escape this fixture')
    return originalFetch(`${origin}/search`, init)
  }) as typeof fetch
  t.after(async () => {
    globalThis.fetch = originalFetch
    if (priorKey === undefined) delete process.env.FIRECRAWL_API_KEY; else process.env.FIRECRAWL_API_KEY = priorKey
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await Promise.all([scope.close(), pool.end(), appPool.end()])
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  })
  // Each normal factory has fresh caches/counters, as separate durable workers do.
  // Actual provider adapter and production admission remain enabled.
  const { createWebService, webSearch, webScrape } = await import('./index')
  const userId = `web-rate-${randomUUID()}`, otherUser = `web-rate-${randomUUID()}`
  const caller = { userId, caller: 'coordinator' as const }
  const workers = Array.from({length:20}, () => createWebService())
  await scope.run(async () => {
    const results = await Promise.all(workers.map((worker, i) => worker.search(`public query ${i}`, caller)))
    assert.equal(results.filter(result => result.ok).length, 10)
    assert.equal(results.filter(result => !result.ok && result.outcome === 'rate_limited').length, 10)
    assert.equal(hits.length, 10, 'excess requests never reach the HTTP provider')
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM "rateLimit"')).rows[0].n), 10)
    assert.deepEqual(await webSearch('blocked exported search', caller), {ok:false,error:'searchUnavailable',outcome:'rate_limited'})
    assert.deepEqual(await webScrape('https://example.invalid/no-fetch', caller), {ok:false,error:'searchUnavailable',outcome:'rate_limited'})
    const cachedIndex = results.findIndex(result => result.ok)
    assert.equal((await workers[cachedIndex].search(`public query ${cachedIndex}`, caller)).ok, true)
    assert.equal(hits.length, 10, 'cache hits do not consume another paid provider request')
    assert.equal((await webSearch('another user', {userId:otherUser,caller:'bot'})).ok, true)
    assert.equal(hits.length, 11)
    // Expire only this nonce schema's disposable window, then recreate a worker.
    await pool.query('UPDATE "rateLimit" SET "lastRequest"=$1', [Date.now()-60_001])
    assert.equal((await createWebService().search('after window / worker restart', caller)).ok, true)
    assert.equal(hits.length, 12)
    const { consumeWebRate } = await import('./rate-limit')
    const prefix = (id: string) => `web-rate:${createHash('sha256').update(id).digest('hex')}:`
    await t.test('admission and refusal each need only four real database round trips', async () => {
      const statements: string[] = [], measuredUser = randomUUID()
      const measured = { connect: async () => {
        const client = await pool.connect()
        return new Proxy(client, { get(target, key) {
          if (key === 'query') return (...args: unknown[]) => {
            statements.push(String(args[0]))
            return Reflect.apply(target.query, target, args)
          }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        } })
      } }
      assert.equal(await consumeWebRate(measured, measuredUser, 100_000, 1), true)
      assert.equal(statements.length, 4, 'BEGIN, per-user lock, admission, COMMIT')
      statements.length = 0
      assert.equal(await consumeWebRate(measured, measuredUser, 100_001, 1), false)
      assert.equal(statements.length, 4, 'denied admission keeps the same bounded database path')
    })
    await t.test('the exact sliding boundary expires only this user and leaves auth counters intact', async () => {
      const slidingUser = randomUUID(), other = randomUUID(), authKey = `auth-fixture:${randomUUID()}`
      await pool.query('INSERT INTO "rateLimit" (id,key,count,"lastRequest") VALUES ($1,$2,7,1)', [randomUUID(),authKey])
      assert.equal(await consumeWebRate(pool, slidingUser, 200_000, 2), true)
      assert.equal(await consumeWebRate(pool, slidingUser, 200_001, 2), true)
      assert.equal(await consumeWebRate(pool, other, 200_000, 1), true)
      assert.equal(await consumeWebRate(pool, slidingUser, 259_999, 2), false)
      assert.equal(await consumeWebRate(pool, slidingUser, 260_000, 2), true)
      assert.equal(await consumeWebRate(pool, slidingUser, 260_000, 2), false)
      assert.equal(await consumeWebRate(pool, slidingUser, 260_001, 2), true)
      assert.deepEqual((await pool.query('SELECT count,"lastRequest"::int AS last FROM "rateLimit" WHERE key=$1', [authKey])).rows,
        [{ count: 7, last: 1 }])
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM "rateLimit" WHERE key LIKE $1', [`${prefix(other)}%`])).rows[0].n, 1)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM "rateLimit" WHERE key LIKE $1', [`${prefix(slidingUser)}%`])).rows[0].n, 2)
    })
    await t.test('a lock waiter reads a fresh snapshot after a competing worker commits the last slot', async () => {
      const lockedUser = randomUUID(), held = await pool.connect(), observer = await pool.connect()
      let waiting: Promise<boolean> | undefined
      try {
        const { rows: [{ pid }] } = await observer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        await held.query('BEGIN')
        await held.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [prefix(lockedUser)])
        waiting = consumeWebRate({ connect: async () => observer }, lockedUser, 300_000, 1)
        const deadline = Date.now() + 5000
        for (;;) {
          const { rows: [row] } = await admin.query(`SELECT EXISTS(SELECT 1 FROM pg_locks
            WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS waiting`, [pid])
          if (row.waiting) break
          assert.ok(Date.now() < deadline, 'the real PostgreSQL contender must reach the advisory lock')
          await delay(2)
        }
        const id = randomUUID()
        await held.query('INSERT INTO "rateLimit" (id,key,count,"lastRequest") VALUES ($1,$2,1,$3)', [id,`${prefix(lockedUser)}${id}`,300_000])
        await held.query('COMMIT')
        assert.equal(await waiting, false)
      } finally {
        await held.query('ROLLBACK')
        held.release()
        if (!waiting) observer.release()
        else await waiting
      }
    })
    await pool.query('ALTER TABLE "rateLimit" RENAME TO unavailable_rate_fixture')
    const denied = await createWebService().search('database unavailable', {userId:`new-${randomUUID()}`,caller:'bot'})
    assert.equal(denied.ok, false)
    assert.equal(hits.length, 12, 'unavailable admission never calls the provider')
  })
})
