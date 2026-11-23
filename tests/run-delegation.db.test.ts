// `delegate_subagent` admission (docs/factory/3089-run-delegation.md, #3089):
// a live parent's child run on the same Agent, computer, repository and task is
// the only run the one-live-per-issue gate may admit beside it. The durable
// delegation marker, the serial-child rule and the no-grandchild rule are all
// enforced inside acceptLocalRun under the task's dispatch lock.
import { seedFixtureWorkspace } from './helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ActionFailureError } from '../lib/action-error'
import { disposableDatabase } from './helpers/e2e-target.mjs'

const connection = process.env.E2E_DATABASE_URL
const enabled = disposableDatabase()
if (connection && !enabled) throw new Error('Run delegation DB tests require a loopback *_e2e database')
if (process.env.REQUIRE_DB === '1' && !enabled) throw new Error('Run delegation DB tests cannot skip in required CI')

test('acceptLocalRun admits a delegated child only on the parent\'s exact scope and only one at a time', { skip: !enabled, timeout: 90_000 }, async t => {
  const { pool } = await import('../lib/db')
  const { acceptLocalRun } = await import('../lib/run-admission-store')
  const { freezeWorkerDefinition } = await import('../lib/agent-kit/worker')
  const userId = `delegation-${randomUUID()}`
  const ids = { workspaceId: randomUUID(), deviceId: randomUUID(), device2: randomUUID(), agentId: randomUUID(), repoId: randomUUID(), issueId: randomUUID(), issue2: randomUUID(), parent: randomUUID() }
  const remoteKey = 'v2/github.com/mikka-ci/delegation'
  const remoteUrl = `https://${remoteKey.slice(3)}.git`
  t.after(async () => {
    await pool.query('DELETE FROM agent_runs WHERE "userId"=$1', [userId])
    await pool.query('DELETE FROM issues WHERE "userId"=$1', [userId])
    await pool.query('DELETE FROM device_repos WHERE "userId"=$1', [userId])
    await pool.query('DELETE FROM agents WHERE "userId"=$1', [userId])
    await pool.query('DELETE FROM devices WHERE "ownerId"=$1', [userId])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "userId"=$1', [userId])
    await pool.query('DELETE FROM mikka_workspaces WHERE "userId"=$1', [userId])
    await pool.query('DELETE FROM "user" WHERE id=$1', [userId])
    await pool.end()
  })
  await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())', [userId, `${userId}@example.invalid`])
  await seedFixtureWorkspace(pool, userId, 'personal', ids.workspaceId)
  const localDevice = JSON.stringify([{ harness: 'codex', installed: true }])
  await pool.query('insert into devices (id,"ownerId",name,kind,harnesses) values ($1,$2,\'Computer A\',\'local\',$3)', [ids.deviceId, userId, localDevice])
  await pool.query('insert into devices (id,"ownerId",name,kind,harnesses) values ($1,$2,\'Computer B\',\'local\',$3)', [ids.device2, userId, localDevice])
  await pool.query('insert into agents (id,"userId","deviceId",harness,name) values ($1,$2,$3,\'codex\',\'codex A\')', [ids.agentId, userId, ids.deviceId])
  await pool.query('insert into device_repos (id,"deviceId","userId","repoPath","remoteUrl","baseBranch") values ($1,$2,$3,$4,$5,null)', [ids.repoId, ids.deviceId, userId, remoteKey, remoteUrl])
  for (const id of [ids.issueId, ids.issue2])
    await pool.query(`insert into issues (id,"userId","workspaceId","ownershipState",scope,title,content,status,priority) values ($1,$2,$3,'bound','personal','Delegate task','{"type":"doc"}','todo','normal')`, [id, userId, ids.workspaceId])
  const parentDefinition = JSON.stringify({ harness: 'codex' })
  await pool.query(`insert into agent_runs (id,"userId","issueId","workspaceId","agentId","deviceId","deviceRepoId",status,kind,prompt,"agentDefinition")
    values ($1,$2,$3,$4,$5,$6,$7,'running','implement','task',$8)`, [ids.parent, userId, ids.issueId, ids.workspaceId, ids.agentId, ids.deviceId, ids.repoId, parentDefinition])

  const child = (key: string, overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(), userId, issueId: ids.issueId, agentId: ids.agentId, deviceId: ids.deviceId, deviceRepoId: ids.repoId,
    botId: null, prompt: 'child', promptTaskStart: 0, promptTaskLength: null, origin: 'api' as const,
    definition: freezeWorkerDefinition({ harness: 'codex', instructions: '', prompt: 'child', parent: null, executionId: null, readOnly: true }),
    dispatch: { issueId: ids.issueId, agentId: ids.agentId, deviceRepoId: ids.repoId, note: 'sub-task', requestKey: key },
    delegation: { parentRunId: ids.parent }, ...overrides,
  })
  const error = async (fn: () => Promise<unknown>) => fn().then(() => null as ActionFailureError | null, (e: unknown) => e as ActionFailureError)
  const reason = (e: ActionFailureError | null) => (e?.params as { reason?: string } | undefined)?.reason

  // The sole live run is the declared parent: the child is admitted and its
  // parent linkage is recorded durably on the frozen definition.
  const first = await acceptLocalRun(child('delegate:one'))
  assert.ok(first.runId)
  const [row] = (await pool.query(`select status,"agentDefinition"->'delegation'->>'parentRunId' as parent from agent_runs where id=$1`, [first.runId])).rows
  assert.equal(row.status, 'queued')
  assert.equal(row.parent, ids.parent)

  // A second delegation while the child is live hits the ordinary conflict —
  // the live sibling is not the declared parent.
  const conflict = await error(() => acceptLocalRun(child('delegate:two')))
  assert.equal(conflict?.code, 'runAlreadyActive')

  // A retry of the same call replays to the child it created.
  const replay = await acceptLocalRun(child('delegate:one'))
  assert.equal(replay.runId, first.runId)
  assert.equal(replay.replayed, true)

  // A run on a different task cannot be named as this child's parent.
  const otherTaskParent = randomUUID()
  await pool.query(`insert into agent_runs (id,"userId","issueId","workspaceId","agentId","deviceId","deviceRepoId",status,kind,prompt,"agentDefinition")
    values ($1,$2,$3,$4,$5,$6,$7,'running','implement','task',$8)`, [otherTaskParent, userId, ids.issue2, ids.workspaceId, ids.agentId, ids.deviceId, ids.repoId, parentDefinition])
  assert.equal(reason(await error(() => acceptLocalRun(child('delegate:three', { delegation: { parentRunId: otherTaskParent } })))), 'delegationUnavailable')

  // Once the original parent ends, a delegated child is the task's only live
  // run — and it may never delegate further: the no-grandchild rule.
  await pool.query('update agent_runs set status=$2 where id=$1', [ids.parent, 'completed'])
  const grandchild = await error(() => acceptLocalRun(child('delegate:four', { delegation: { parentRunId: first.runId } })))
  assert.equal(reason(grandchild), 'delegationUnavailable')

  // A finished run cannot be named as parent: the live-run rule, not the
  // caller's claim, decides.
  const staleParent = randomUUID()
  await pool.query(`insert into agent_runs (id,"userId","issueId","workspaceId","agentId","deviceId","deviceRepoId",status,kind,prompt,"agentDefinition")
    values ($1,$2,$3,$4,$5,$6,$7,'completed','implement','task',$8)`, [staleParent, userId, ids.issueId, ids.workspaceId, ids.agentId, ids.deviceId, ids.repoId, parentDefinition])
  assert.equal(reason(await error(() => acceptLocalRun(child('delegate:five', { delegation: { parentRunId: staleParent } })))), 'delegationUnavailable')
})
