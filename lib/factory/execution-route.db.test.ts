// #3081/#3087: the explicit execution route is resolved and frozen on dispatch,
// and the canonical execution envelope reads back over a disposable *_e2e PG.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Pool, type PoolClient } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { createFactoryStore } from './store'
import { createFactoryDispatch, factoryBinding, type FactoryQueue } from './dispatch'
import { factoryCheckIndependent } from './check-independence'
import { FactoryError } from './contract'
import { EXECUTION_ROUTE_VERSION } from './execution-route'
import { readFactoryExecutionView } from './execution-view'
import { handleFactoryExecution } from './execution-http'
import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'
import { isE2eTarget, E2E_DB_RULE } from '../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(isE2eTarget(url), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs E2E_DATABASE_URL')

test('dispatch freezes the resolved route on the attempt; the execution view reads one envelope', { skip: !url, timeout: 180_000 }, async () => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const database = `exec_route_${randomUUID().replaceAll('-', '')}_e2e`
  await createTestDatabase(admin, database, 'template0')
  const target = new URL(url!)
  target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.toString(), max: 8 })
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(file => file.endsWith('.sql'))))
      await pool.query(await readFile(new URL(file, dir), 'utf8'))
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture','route@example.invalid',true,now(),now())`)
    const authorize = async (user: string, issue: string, tx: PoolClient) =>
      (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issue, user])).rowCount === 1
    const localDevice = randomUUID(), cloudDevice = randomUUID(), agentId = randomUUID(), cursorAgent = randomUUID()
    const localRepo = randomUUID(), cloudRepo = randomUUID()
    // Local daemon device (kind defaults to 'local') and a cloud task-machine device.
    await pool.query(`INSERT INTO devices (id,"ownerId",name,"lastSeenAt",harnesses,"sessionOpenedAt") VALUES ($1,'owner','Local',now(),'[{"harness":"codex","installed":true},{"harness":"cursor","installed":true}]',now())`, [localDevice])
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"lastSeenAt",harnesses,"sessionOpenedAt") VALUES ($1,'owner','Cloud','cloud',now(),'[{"harness":"codex","installed":true}]',now())`, [cloudDevice])
    await pool.query(`INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,'owner','Codex','codex',$2),($3,'owner','Cursor','cursor',$2)`, [agentId, localDevice, cursorAgent])
    await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,'owner','/fixture/local'),($3,$4,'owner','/fixture/cloud')`, [localRepo, localDevice, cloudRepo, cloudDevice])
    const store = createFactoryStore(pool, authorize, null, { independent: factoryCheckIndependent })
    const adapters = (harness: string) => ({
      configure: { execute: async () => {} } as never,
      freeze: async (tx: PoolClient, _task: unknown, runId: string) => {
        await tx.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [runId, JSON.stringify({ schemaVersion: 1, definitionDigest: 'fixture', harness })])
      },
    })
    const queueOn = (deviceId: string): FactoryQueue => async (tx, userId, input, botId) => {
      const runId = randomUUID()
      await tx.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,prompt) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued','Fixture')`, [runId, userId, input.issueId, input.agentId, deviceId, input.deviceRepoId, botId])
      return { runId }
    }
    const routeIssue = async () => {
      const issueId = randomUUID(), sourceEventId = randomUUID()
      await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState") VALUES ($1,'owner','Fixture','{}','todo','normal',$2,'bound')`, [issueId, await seedFixtureWorkspace(pool, 'owner')])
      await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"synthetic"}')`, [sourceEventId, sourceEventId])
      return (await store.route('owner', { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Task requested', missingInformation: [], missingPermissions: [], needsSpec: false })).task
    }

    // Local codex run → declared device.codex route, recorded on the attempt.
    const task = await routeIssue()
    const dispatch = createFactoryDispatch(pool, store, queueOn(localDevice), adapters('codex'))
    const result = await dispatch('owner', { binding: factoryBinding(task), agentId, deviceRepoId: localRepo })
    const { rows: [attempt] } = await pool.query(`SELECT output->'executionRoute' AS route FROM factory_attempts WHERE id=$1`, [task.attemptId])
    assert.deepEqual(attempt.route, {
      version: EXECUTION_ROUTE_VERSION, routeId: 'device.codex', place: 'device', executor: 'local_daemon',
      harness: 'codex', provider: null, declared: true,
    }, 'resolved route is frozen on the attempt record')

    // The canonical envelope reads the same route, run, thread and cost shape.
    const view = await readFactoryExecutionView(pool, store, 'owner', task.id)
    assert.equal(view.version, 1)
    assert.equal(view.task.id, task.id)
    assert.equal(view.executions.length, 1)
    const execution = view.executions[0]
    assert.equal(execution.attemptId, task.attemptId)
    assert.equal(execution.runId, result.runId)
    assert.equal(execution.threadId, result.runId, 'a single-run chain roots at itself')
    assert.equal(execution.routeSource, 'recorded')
    assert.equal(execution.route?.routeId, 'device.codex')
    assert.equal(execution.executor, 'local_daemon')
    assert.equal(execution.place, 'device')
    assert.equal(execution.harness, 'codex')
    assert.equal(execution.runUnavailable, false)
    assert.deepEqual(execution.cost, { source: 'unavailable', computeSeconds: null })
    assert.ok(execution.timers.runQueuedAt)

    // Cloud codex run → cloud.codex route; cost comes from thread_machines.
    const cloudTask = await routeIssue()
    await createFactoryDispatch(pool, store, queueOn(cloudDevice), adapters('codex'))('owner', { binding: factoryBinding(cloudTask), agentId, deviceRepoId: cloudRepo })
    const { rows: [cloudAttempt] } = await pool.query(`SELECT a.output->'executionRoute' AS route,a."runId" FROM factory_attempts a WHERE a.id=$1`, [cloudTask.attemptId])
    assert.equal(cloudAttempt.route.routeId, 'cloud.codex')
    assert.equal(cloudAttempt.route.executor, 'cf_task_machine')
    await pool.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","sandboxId","snapshotId","operationId",state,"deviceId","computeSeconds") VALUES ($1,$2,'owner','sandbox-1','snap-1',$3,'running',$4,42)`,
      [cloudAttempt.runId, (await pool.query('SELECT "workspaceId" FROM issues WHERE id=$1', [cloudTask.issueId])).rows[0].workspaceId, randomUUID(), cloudDevice])
    const cloudView = await readFactoryExecutionView(pool, store, 'owner', cloudTask.id)
    assert.deepEqual(cloudView.executions[0].cost, { source: 'thread_machines', computeSeconds: 42 })

    // A persisted run outside the matrix refuses the dispatch outright: the
    // cloud device with a non-declared harness leaves no run and no receipt.
    const refusedTask = await routeIssue()
    const refused = createFactoryDispatch(pool, store, queueOn(cloudDevice), adapters('cursor'))
    await assert.rejects(
      refused('owner', { binding: factoryBinding(refusedTask), agentId: cursorAgent, deviceRepoId: cloudRepo }),
      (error: unknown) => error instanceof FactoryError && error.code === 'factoryRouteUnavailable',
    )
    const { rows: [refusedAttempt] } = await pool.query(`SELECT output->'executionRoute' AS route FROM factory_attempts WHERE id=$1`, [refusedTask.attemptId])
    assert.equal(refusedAttempt?.route ?? null, null)
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1`, [refusedTask.issueId])).rows[0].n, 0,
      'the refused dispatch rolled its queued run back')

    // The HTTP handler fences identity exactly like the activity surface.
    assert.deepEqual(await handleFactoryExecution(pool, store, { userId: null, taskId: task.id }), { status: 401, body: { error: 'authRequired' } })
    assert.deepEqual(await handleFactoryExecution(pool, store, { userId: 'owner', taskId: 'not-a-uuid' }), { status: 404, body: { error: 'factoryNotFound' } })
    const denied = await handleFactoryExecution(pool, store, { userId: 'intruder', taskId: task.id })
    assert.equal(denied.status, 404)
  } finally {
    await dropTestDatabase(admin, database, pool)
    await admin.end()
  }
})
