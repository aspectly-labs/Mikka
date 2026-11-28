import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { seedCoordinator } from '../../tests/support/coordinator-bot'
import { seedUser } from '../../tests/support/workspace-admin-db'
import { createRequestScope, runRequestScope } from '../../apps/api/src/context'

const target = process.env.E2E_DATABASE_URL
const ready = Boolean(target && disposableDatabase(process.env, target) && process.env.DATABASE_URL === target && process.env.MIKKA_DATABASE_URL === target)
if (process.env.REQUIRE_DB === '1') assert.ok(ready, 'matching isolated loopback *_e2e databases are required')

test('a welcome wakes through its stored event', { skip: !ready, timeout: 60_000 }, async t => {
  const jobs: Promise<unknown>[] = []
  const next = await import('@/lib/server-runtime/server')
  t.mock.module('@/lib/server-runtime/server', { namedExports: { ...next, after: (work: () => Promise<unknown>) => { jobs.push(work()) } } })
  const { pool } = await import('../db')
  const { workspacePool } = await import('../workspace-db')
  const { coordinatorWakeTransport } = await import('./wake-after-commit')
  const { overrideDeploymentSwitch } = await import('../deployment-switches')
  const owner = await seedUser(pool, 'owner-event-wake'), sessionId = randomUUID()
  const { botId, workspaceId } = await seedCoordinator(owner)
  await pool.query('INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())', [sessionId, owner, randomUUID()])
  const committed: string[] = [], direct: string[] = []
  let observed: (() => void) | undefined
  const wake = () => new Promise<void>(resolve => { observed = resolve })
  coordinatorWakeTransport.wake = async userId => {
    committed.push(userId)
    observed?.()
  }
  overrideDeploymentSwitch('personalWrites', true)
  t.after(async () => {
    delete coordinatorWakeTransport.wake
    overrideDeploymentSwitch('personalWrites', undefined)
    // The real operation ledger is immutable. Other operation DB suites also
    // retain its owner and operation in this disposable, fully migrated DB.
    t.diagnostic(JSON.stringify({ retainedOwner: owner, reason: 'immutable personal operation ledger' }))
    await (await import('../builtin-gateway/runtime')).builtinGateway()?.stop()
    await Promise.all([pool.end(), workspacePool.end()])
  })
  let viewer: { user: { id: string; email: string; name: string }; session: { id: string } } | null = null
  const authenticated = { user: { id: owner, email: owner + '@example.invalid', name: 'Fixture' }, session: { id: sessionId } }
  let configured = true
  let modelReady = false
  const modelChoice = await import('../bot-model-choice')
  t.mock.module('../bot-model-choice', { namedExports: { ...modelChoice, resolveBotModelChoice: async () => modelReady ? { kind: 'hosted', model: 'fixture/model', chosen: true } : { kind: 'none', chosen: false } } })
  const realAuth = await import('../auth')
  t.mock.module('../auth', { namedExports: { ...realAuth, auth: { api: { getSession: async () => viewer } } } })
  const existingWake = await import('./wake')
  t.mock.module('./wake', { namedExports: { ...existingWake, coordinatorEnabled: async () => configured, wakeCoordinator: async (userId: string) => { direct.push(userId) } } })
  const { welcomeCoordinator: welcome } = await import('../../app/actions/coordinator')
  // Authentication may import workspace readers before this fixture installs
  // its session stub. Exercise the real request-bound headers and cookie jar.
  async function scoped<T>(request: Request, work: () => Promise<T>) {
    const scope = createRequestScope(request)
    try { return await runRequestScope(scope, work) }
    finally { await scope.after.finish() }
  }
  const welcomeCoordinator = (...args: Parameters<typeof welcome>) => scoped(new Request('https://fixture.invalid/actions/coordinator', {
    headers: { cookie: `mikka-workspace=${workspaceId}`, 'x-mikka-locale': 'en' },
  }), () => welcome(...args))
  await t.test('a ready, authenticated empty Bot receives one welcome', async () => {
    assert.equal((await welcomeCoordinator(botId)).error, 'authRequired')
    viewer = authenticated
    configured = false
    assert.deepEqual(await welcomeCoordinator(botId), { queued: false })
    configured = true
    assert.deepEqual(await welcomeCoordinator(botId), { queued: false, reason: 'modelRequired' })
    assert.equal((await pool.query('SELECT count(*)::int count FROM coordinator_events WHERE "userId"=$1', [owner])).rows[0].count, 0)
    assert.deepEqual(committed, [])
    assert.deepEqual(direct, [])
    modelReady = true
    const delivered = wake()
    assert.deepEqual(await welcomeCoordinator(botId), { queued: true })
    await delivered
    await Promise.all(jobs.splice(0))
    const row = await pool.query('SELECT "botId",payload->>\'source\' AS source FROM coordinator_events WHERE "userId"=$1 AND kind=$2', [owner, 'user_message'])
    assert.deepEqual(row.rows, [{ botId, source: 'coordinator_welcome' }])
    assert.deepEqual(committed, [owner])
    assert.deepEqual(direct, [])
  })
})
