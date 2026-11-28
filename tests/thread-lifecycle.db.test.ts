import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { pool } from '../lib/db'
import {
  bindSlackThread, createThreadShare, revokeThreadShares, deleteThread, listThreadChildren, moveThread,
  patchThread, restoreThread, sharedThread, spawnThread, ThreadSpawnConflictError,
} from '../lib/thread-lifecycle.js'
import { remoteKey } from '@mikka/protocol/repository'
import { seedAgent, seedIssue, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db.js'
import { tokenWorkspace } from '../lib/tokens/principal.js'

const owner = { id: '', [tokenWorkspace]: '' }
const outsider = { id: '', [tokenWorkspace]: '' }
const kept: string[] = []

async function fixture() {
  owner.id = await seedUser(pool, 'life-owner')
  outsider.id = await seedUser(pool, 'life-other')
  const workspace = await seedWorkspace(pool, owner.id, [{ userId: owner.id, role: 'admin' }])
  // A workspace-pinned token's scope: runsOutsideToken requires it.
  owner[tokenWorkspace] = workspace.id
  outsider[tokenWorkspace] = workspace.id
  const agentId = await seedAgent(pool, owner.id)
  const issueId = await seedIssue(pool, owner.id, workspace.id)
  const rootId = await seedRun(pool, { userId: owner.id, agentId, workspaceId: workspace.id, issueId, status: 'succeeded' })
  kept.push(rootId)
  return { workspace, agentId, issueId, rootId }
}

test.after(async () => {
  if (kept.length) await pool.query(`UPDATE agent_runs SET "deletedAt"=now() WHERE id = ANY($1::uuid[])`, [kept])
})

test('fork full replays transcript and anchors to the chain root; side thread anchors to its message', async () => {
  const { rootId } = await fixture()
  const attempt = randomUUID()
  await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","workspaceId","issueId",status,"retryOf") SELECT $1,"userId","agentId","workspaceId","issueId",'succeeded',$2 FROM agent_runs WHERE id=$2`, [attempt, rootId])
  kept.push(attempt)
  await pool.query(`INSERT INTO run_messages (id,"runId","userId",text) VALUES ($1,$2,$3,'first'),($4,$5,$3,'second')`, [randomUUID(), rootId, owner.id, randomUUID(), rootId])

  const full = await spawnThread(owner, attempt, { relation: 'fork', mode: 'full' })
  assert.ok(full)
  kept.push(full.id)
  assert.equal(full.parentRunId, rootId)
  assert.equal(full.threadRelation, 'fork')
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM run_messages WHERE "runId"=$1`, [full.id])).rows[0].n, 2)

  const summary = await spawnThread(owner, rootId, { relation: 'fork', mode: 'summary' })
  assert.ok(summary)
  kept.push(summary.id)
  assert.match(summary.prompt, /first/)
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM run_messages WHERE "runId"=$1`, [summary.id])).rows[0].n, 0)

  const messageId = randomUUID()
  await pool.query(`INSERT INTO run_messages (id,"runId","userId",text) VALUES ($1,$2,$3,'anchor')`, [messageId, attempt, owner.id])
  const side = await spawnThread(owner, attempt, { relation: 'side', fromMessageId: messageId })
  assert.ok(side)
  kept.push(side.id)
  assert.equal(side.threadRelation, 'side')
  assert.equal(side.sourceMessageId, messageId)

  const children = await listThreadChildren(owner, rootId)
  assert.deepEqual(children?.map(child => child.threadRelation).sort(), ['fork', 'fork', 'side'])

  // A non-owner spawns nothing, shares nothing, and sees no children.
  assert.equal(await spawnThread(outsider, rootId, { relation: 'fork', mode: 'full' }), null)
  assert.equal(await listThreadChildren(outsider, rootId), null)
})

test('spawnThread honors idempotencyKey replays without duplicating history and rejects mismatched payloads', async () => {
  const { rootId } = await fixture()
  await pool.query(`INSERT INTO run_messages (id,"runId","userId",text) VALUES ($1,$2,$3,'seed message')`, [randomUUID(), rootId, owner.id])
  const key = `fork-idem-${randomUUID()}`
  const first = await spawnThread(owner, rootId, { relation: 'fork', mode: 'full', idempotencyKey: key })
  assert.ok(first)
  kept.push(first.id)
  const replay = await spawnThread(owner, rootId, { relation: 'fork', mode: 'full', idempotencyKey: key })
  assert.ok(replay)
  assert.equal(replay.id, first.id)
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM run_messages WHERE "runId"=$1`, [first.id])).rows[0].n, 1)
  await assert.rejects(
    () => spawnThread(owner, rootId, { relation: 'fork', mode: 'summary', idempotencyKey: key }),
    ThreadSpawnConflictError,
  )
})

test('spawnThread reuses an idempotencyKey after the previous child is soft-deleted', async () => {
  const { rootId } = await fixture()
  await pool.query(`INSERT INTO run_messages (id,"runId","userId",text) VALUES ($1,$2,$3,'seed message')`, [randomUUID(), rootId, owner.id])
  const key = `fork-deleted-${randomUUID()}`
  const first = await spawnThread(owner, rootId, { relation: 'fork', mode: 'full', idempotencyKey: key })
  assert.ok(first)
  kept.push(first.id)
  assert.equal(await deleteThread(owner, first.id), true)
  const { rows: [tombstone] } = await pool.query(
    `SELECT "deletedAt","dispatchKey" FROM agent_runs WHERE id=$1`, [first.id])
  assert.ok(tombstone.deletedAt)
  assert.equal(tombstone.dispatchKey, null)

  const again = await spawnThread(owner, rootId, { relation: 'fork', mode: 'full', idempotencyKey: key })
  assert.ok(again)
  kept.push(again.id)
  assert.notEqual(again.id, first.id)
  assert.equal(again.deletedAt, null)
  assert.equal(again.dispatchKey, `thread_spawn:fork:${key}`)
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM run_messages WHERE "runId"=$1`, [again.id])).rows[0].n, 1)

  const replay = await spawnThread(owner, rootId, { relation: 'fork', mode: 'full', idempotencyKey: key })
  assert.ok(replay)
  assert.equal(replay.id, again.id)
})

test('share links read only the transcript and revoking ends access', async () => {
  const { rootId } = await fixture()
  await pool.query(`INSERT INTO run_messages (id,"runId","userId",text) VALUES ($1,$2,$3,'hello thread')`, [randomUUID(), rootId, owner.id])
  const share = await createThreadShare(owner, rootId)
  assert.ok(share)
  const thread = await sharedThread(share.token)
  assert.equal(thread?.id, rootId)
  assert.equal(thread?.messages.length, 1)
  assert.equal(await sharedThread(`mkt_${'x'.repeat(10)}`), null)
  assert.equal(await revokeThreadShares(owner, rootId), 1)
  assert.equal(await sharedThread(share.token), null)
  assert.equal(await createThreadShare(outsider, rootId), null)
})

test('patch moves task binding and tags on the root; foreign, cross-workspace and subagent targets are refused', async () => {
  const { rootId, workspace, agentId } = await fixture()
  const otherIssue = await seedIssue(pool, outsider.id)
  const run = await patchThread(owner, rootId, { taskId: otherIssue, tags: ['review'] })
  assert.equal(run, 'forbidden')
  // Cross-workspace linking is refused even for the same owner.
  const otherWorkspace = await seedWorkspace(pool, owner.id, [{ userId: owner.id, role: 'admin' }])
  const crossWorkspaceIssue = await seedIssue(pool, owner.id, otherWorkspace.id)
  assert.equal(await patchThread(owner, rootId, { taskId: crossWorkspaceIssue }), 'forbidden')
  const next = await seedIssue(pool, owner.id, workspace.id)
  const patched = await patchThread(owner, rootId, { taskId: next, tags: ['a', 'b'] })
  assert.ok(patched && patched !== 'forbidden')
  assert.equal(patched.issueId, next)
  assert.deepEqual(patched.tags, ['a', 'b'])
  assert.deepEqual((await pool.query(`SELECT "parentKind","parentId" FROM resource_access_policies WHERE kind='thread' AND id=$1`, [rootId])).rows[0], { parentKind: 'task', parentId: next })
  // Unlinking sets issueId to null and clears the root thread's task ACL parent.
  const unlinked = await patchThread(owner, rootId, { taskId: null })
  assert.ok(unlinked && unlinked !== 'forbidden')
  assert.equal(unlinked.issueId, null)
  assert.deepEqual((await pool.query(`SELECT "parentKind","parentId" FROM resource_access_policies WHERE kind='thread' AND id=$1`, [rootId])).rows[0], { parentKind: null, parentId: null })
  // Re-link back to next alongside a retry descendant; the recursive UPDATE moves both.
  const retryId = randomUUID()
  await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","workspaceId","issueId",status,"retryOf") SELECT $1,"userId","agentId","workspaceId","issueId",'succeeded',$2 FROM agent_runs WHERE id=$2`, [retryId, rootId])
  kept.push(retryId)
  const relinked = await patchThread(owner, rootId, { taskId: next })
  assert.ok(relinked && relinked !== 'forbidden')
  assert.equal(relinked.issueId, next)
  assert.equal((await pool.query(`SELECT "issueId" FROM agent_runs WHERE id=$1`, [retryId])).rows[0]?.issueId, next)
  assert.deepEqual((await pool.query(`SELECT "parentKind","parentId" FROM resource_access_policies WHERE kind='thread' AND id=$1`, [rootId])).rows[0], { parentKind: 'task', parentId: next })
  // Active Factory execute attempts cannot be moved or unlinked off their task,
  // while a completed task with a superseded earlier waiting attempt can be moved again.
  const factoryTaskId = randomUUID(), attemptId = randomUUID(), resumedAttemptId = randomUUID(), sourceEventId = randomUUID()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO factory_tasks (id,"userId","workspaceId","issueId","sourceEventId",route,stage,status,"attemptId",reason)
       VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,'execute','running',$6,'active test')`,
      [factoryTaskId, owner.id, workspace.id, next, sourceEventId, attemptId])
    await client.query(
      `INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"runId",reason)
       VALUES ($1,$2,'execute',1,1,'waiting',$3,'waiting question')`,
      [attemptId, factoryTaskId, rootId])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  assert.equal(await patchThread(owner, rootId, { taskId: null }), null)
  // Once a resumed attempt finishes and becomes current, the superseded waiting attempt no longer locks the thread.
  const finishClient = await pool.connect()
  try {
    await finishClient.query('BEGIN')
    await finishClient.query(
      `INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"runId",reason)
       VALUES ($1,$2,'execute',2,2,'passed',$3,'resumed done')`,
      [resumedAttemptId, factoryTaskId, retryId])
    await finishClient.query(
      `UPDATE factory_tasks SET status='passed',"attemptId"=$2 WHERE id=$1`,
      [factoryTaskId, resumedAttemptId])
    await finishClient.query('COMMIT')
  } catch (error) { await finishClient.query('ROLLBACK'); throw error } finally { finishClient.release() }
  const afterFactoryDone = await patchThread(owner, rootId, { taskId: null })
  assert.ok(afterFactoryDone && afterFactoryDone !== 'forbidden')
  assert.equal(afterFactoryDone.issueId, null)
  const relinkAfterFactory = await patchThread(owner, rootId, { taskId: next })
  assert.ok(relinkAfterFactory && relinkAfterFactory !== 'forbidden')
  assert.equal(relinkAfterFactory.issueId, next)
  await pool.query(`DELETE FROM factory_tasks WHERE id=$1`, [factoryTaskId])
  // Subagent runs cannot be retargeted independently.
  const subagentId = await seedRun(pool, { userId: owner.id, agentId, workspaceId: workspace.id, issueId: next, status: 'succeeded' })
  kept.push(subagentId)
  await pool.query(`UPDATE agent_runs SET "parentRunId"=$2,"threadRelation"='subagent' WHERE id=$1`, [subagentId, rootId])
  assert.equal(await patchThread(owner, subagentId, { taskId: null }), null)
  assert.equal(await patchThread(outsider, rootId, { tags: [] }), null)
})

test('soft-delete hides the thread from operations and restores inside the window', async () => {
  const { rootId } = await fixture()
  assert.equal(await deleteThread(owner, rootId), true)
  assert.equal(await spawnThread(owner, rootId, { relation: 'fork', mode: 'summary' }), null)
  assert.equal(await patchThread(owner, rootId, { tags: [] }), null)
  assert.equal(await deleteThread(owner, rootId), null)
  assert.equal(await restoreThread(owner, rootId), true)
  const { rows: [row] } = await pool.query(`SELECT "deletedAt" FROM agent_runs WHERE id=$1`, [rootId])
  assert.equal(row.deletedAt, null)
  // Past the recovery window restore is a no-op.
  await pool.query(`UPDATE agent_runs SET "deletedAt"=now()-interval '40 days',"deletedBy"=$2 WHERE id=$1`, [rootId, owner.id])
  assert.equal(await restoreThread(owner, rootId), false)
})

test('move retargets a queued run device↔device and a settled thread to cloud, only for the owner', async () => {
  const { rootId, workspace, agentId, issueId } = await fixture()
  const botId = randomUUID()
  await pool.query(`INSERT INTO bots (id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,'movebot')`, [botId, workspace.id, owner.id])
  await pool.query(`UPDATE agent_runs SET "botId"=$2 WHERE id=$1`, [rootId, botId])
  const sourceDevice = randomUUID(), deviceId = randomUUID(), cloudDevice = randomUUID()
  await pool.query(`INSERT INTO devices (id,"ownerId",name) VALUES ($1,$3,'src'),($2,$3,'box')`, [sourceDevice, deviceId, owner.id])
  await pool.query(`INSERT INTO devices (id,"ownerId",name,kind) VALUES ($1,$2,'cloud','cloud')`, [cloudDevice, owner.id])
  const remote = 'https://github.com/acme/app.git'
  const sourceRepo = randomUUID()
  await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)`, [sourceRepo, sourceDevice, owner.id, remoteKey(remote), remote])
  // The Bot's cloud runtime: a cloud Agent + its repo, registered for the
  // chain's harness — a move to cloud requires it (the next reply would
  // otherwise never dispatch).
  const cloudAgentId = randomUUID(), cloudRepoId = randomUUID()
  await pool.query(`INSERT INTO agents (id,"userId",harness,name,"deviceId") VALUES ($1,$2,'codex','cloudagent',$3)`, [cloudAgentId, owner.id, cloudDevice])
  await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)`, [cloudRepoId, cloudDevice, owner.id, remoteKey(remote), remote])
  await pool.query(`INSERT INTO bot_cloud_runtimes ("botId","ownerId","workspaceId",harness,"agentId","repoId") VALUES ($1,$2,$3,'codex',$4,$5)`, [botId, owner.id, workspace.id, cloudAgentId, cloudRepoId])
  await pool.query(`UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3 WHERE id=$1`, [rootId, sourceDevice, sourceRepo])
  // A queued attempt of the same chain moves with it; its claim re-validates
  // repo and device on the destination.
  const queuedId = randomUUID()
  await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","workspaceId","issueId","botId",status,"retryOf","deviceId","deviceRepoId")
    SELECT $1,"userId","agentId","workspaceId","issueId","botId",'queued',$2,$3,$4 FROM agent_runs WHERE id=$2`, [queuedId, rootId, sourceDevice, sourceRepo])
  kept.push(queuedId)
  // A queued run's claim re-validates the frozen identity — freeze one on the
  // source device so the move proves the rebind actually retargets it.
  await pool.query(`UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1`, [queuedId, JSON.stringify({ harness: 'codex', executionIdentity: {
    version: 1, requester: owner.id, botId, botOwner: owner.id, executionPrincipal: owner.id, workspaceId: workspace.id, outputOwner: owner.id,
    resourceBindings: [{ kind: 'device', id: sourceDevice, ownerId: owner.id, access: 'owner' }],
    billingAccount: { model: { kind: 'native_login', ownerId: owner.id, resourceId: sourceDevice, amount: 'provider_unknown' },
      runtime: { kind: 'local_device', ownerId: owner.id, resourceId: sourceDevice, amount: 'not_applicable' } },
    personalResourcePolicy: 'requester_only' } })])
  await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId","sandboxId","deviceId",state) VALUES ($1,$2,$3,$4,$5,'running')`, [workspace.id, owner.id, randomUUID(), `synthetic-${rootId.slice(0, 8)}`, cloudDevice])

  // A queued run cannot move onto cloud — a retarget cannot synthesize its
  // provisioned thread machine.
  assert.equal(await moveThread(owner, rootId, { deviceId: 'cloud' }), null)

  assert.equal(await moveThread(owner, rootId, { deviceId }), true)
  const { rows: [moved] } = await pool.query(
    `SELECT r."deviceId", r."deviceRepoId", r."machineAuthority", r."agentDefinition"->'executionIdentity' AS identity, repo."deviceId" AS "repoDevice" FROM agent_runs r JOIN device_repos repo ON repo.id=r."deviceRepoId" WHERE r.id=$1`, [queuedId])
  assert.equal(moved.deviceId, deviceId)
  assert.equal(moved.repoDevice, deviceId)
  assert.equal(moved.machineAuthority, false)
  assert.notEqual(moved.deviceRepoId, sourceRepo)
  // The frozen device grant was rebound to the destination.
  assert.equal((moved.identity as { resourceBindings: { id: string }[] }).resourceBindings[0].id, deviceId)

  // Once the chain settles the thread may move to cloud; the newest run gains
  // the binding that steers the next continuation onto the cloud path. A frozen
  // identity whose grants cannot travel — this fixture's model configuration is
  // refused before any key check — denies the move outright, before the
  // identity is lifted for the happy path.
  await pool.query(`UPDATE agent_runs SET status='succeeded' WHERE id=$1`, [queuedId])
  assert.equal(await moveThread(owner, rootId, { deviceId: 'cloud' }), null)
  await pool.query(`UPDATE agent_runs SET "agentDefinition"='{}' WHERE id=$1`, [queuedId])
  assert.equal(await moveThread(owner, rootId, { deviceId: 'cloud' }), true)
  const { rows: [back] } = await pool.query(
    `SELECT r."deviceId", r."agentId", r."machineAuthority", repo."deviceId" AS "repoDevice" FROM agent_runs r JOIN device_repos repo ON repo.id=r."deviceRepoId" WHERE r.id=$1`, [queuedId])
  assert.equal(back.deviceId, cloudDevice)
  assert.equal(back.repoDevice, cloudDevice)
  assert.equal(back.machineAuthority, true)
  // The newest run now answers to the Bot's cloud Agent, so the next reply's
  // model resolves that Agent's subscription.
  assert.equal(back.agentId, cloudAgentId)
  const { rows: [binding] } = await pool.query(`SELECT "botId","workspaceId" FROM computer_run_bindings WHERE "runId"=$1`, [queuedId])
  assert.equal(binding?.botId, botId)
  assert.equal(binding?.workspaceId, workspace.id)

  // Moving back to a device with one of the chain's Agents drops the cloud
  // binding and points the newest run at that Agent, so the next reply queues
  // locally under its own device.
  await pool.query(`UPDATE agents SET "deviceId"=$2 WHERE id=$1`, [agentId, deviceId])
  assert.equal(await moveThread(owner, rootId, { deviceId }), true)
  const { rows: [gone] } = await pool.query(`SELECT 1 FROM computer_run_bindings WHERE "runId"=$1`, [queuedId])
  assert.equal(gone, undefined)
  const { rows: [home] } = await pool.query(`SELECT "agentId" FROM agent_runs WHERE id=$1`, [queuedId])
  assert.equal(home?.agentId, agentId)

  // A settled thread moves only where its agent already runs — the continuation
  // resolves the agent's device, so any other target would silently run local.
  const otherDevice = randomUUID()
  await pool.query(`INSERT INTO devices (id,"ownerId",name) VALUES ($1,$2,'other')`, [otherDevice, owner.id])
  assert.equal(await moveThread(owner, rootId, { deviceId: otherDevice }), null)
  await pool.query(`UPDATE agents SET "deviceId"=$2 WHERE id=$1`, [agentId, deviceId])
  assert.equal(await moveThread(owner, rootId, { deviceId }), true)

  // A thread without a repository cannot run anywhere else — the move refuses.
  const bareRoot = await seedRun(pool, { userId: owner.id, agentId, workspaceId: workspace.id, issueId })
  kept.push(bareRoot)
  assert.equal(await moveThread(owner, bareRoot, { deviceId }), null)
  assert.equal(await moveThread(outsider, rootId, { deviceId: 'cloud' }), null)
})

test('slack binding attaches a Slack thread to this thread only for its owner', async () => {
  const { rootId, workspace } = await fixture()
  const linkId = randomUUID()
  const { rows: [bot] } = await pool.query(`INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,'bindbot') RETURNING id`, [randomUUID(), owner.id, workspace.id])
  await pool.query(`INSERT INTO slack_thread_bots ("linkId","channelId","threadTs","ownerId","botId") VALUES ($1,'C1','1720.0001',$2,$3)`, [linkId, owner.id, bot.id])
  assert.equal(await bindSlackThread(owner, rootId, { linkId, channelId: 'C1', threadTs: '1720.0001' }), true)
  const { rows: [bound] } = await pool.query(`SELECT "boundRunId" FROM slack_thread_bots WHERE "linkId"=$1`, [linkId])
  assert.equal(bound.boundRunId, rootId)
  assert.equal(await bindSlackThread(outsider, rootId, { linkId, channelId: 'C1', threadTs: '1720.0001' }), null)
})

test('continuing a completed side thread preserves its side chain and leaves the primary Factory task unchanged', async () => {
  const { rootId, workspace, agentId, issueId } = await fixture()
  const deviceId = randomUUID(), repoId = randomUUID()
  const remote = 'https://github.com/acme/side-cont.git'
  await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,harnesses) VALUES ($1,$2,'local-side','local',true,'[{"harness":"codex","installed":true}]'::jsonb)`, [deviceId, owner.id])
  await pool.query(`UPDATE agents SET "deviceId"=$2, harness='codex' WHERE id=$1`, [agentId, deviceId])
  await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)`, [repoId, deviceId, owner.id, remoteKey(remote), remote])
  await pool.query(`UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3,"agentDefinition"=$4::jsonb WHERE id=$1`, [
    rootId, deviceId, repoId, JSON.stringify({ harness: 'codex', model: 'gpt-5.4' }),
  ])

  // Primary task has an active/passed Factory task and attempt referencing rootId.
  const factoryTaskId = randomUUID(), attemptId = randomUUID(), primarySourceEventId = randomUUID()
  const seedClient = await pool.connect()
  try {
    await seedClient.query('BEGIN')
    await seedClient.query(
      `INSERT INTO factory_tasks (id,"userId","workspaceId","issueId","sourceEventId",route,stage,status,"attemptId",reason)
       VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,'execute','passed',$6,'primary done')`,
      [factoryTaskId, owner.id, workspace.id, issueId, primarySourceEventId, attemptId],
    )
    await seedClient.query(
      `INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"runId",reason)
       VALUES ($1,$2,'execute',1,1,'passed',$3,'primary attempt')`,
      [attemptId, factoryTaskId, rootId],
    )
    await seedClient.query('COMMIT')
  } catch (error) { await seedClient.query('ROLLBACK'); throw error } finally { seedClient.release() }

  const side = await spawnThread(owner, rootId, { relation: 'side', question: 'What does helper X do?' })
  assert.ok(side)
  kept.push(side.id)
  await pool.query(`UPDATE agent_runs SET status='succeeded' WHERE id=$1`, [side.id])

  const { sendThreadMessage } = await import('../lib/thread-continue.js')
  const followUp = await sendThreadMessage(owner.id, side.id, 'Can you also check caller Y?', 'user', randomUUID())
  assert.equal(followUp.continued, true)
  assert.notEqual(followUp.runId, side.id)
  kept.push(followUp.runId)

  const { rows: [continuedRun] } = await pool.query<{ continuesRunId: string | null; threadRelation: string | null; status: string }>(
    `SELECT "continuesRunId","threadRelation",status FROM agent_runs WHERE id=$1`,
    [followUp.runId],
  )
  assert.equal(continuedRun.continuesRunId, side.id)
  assert.equal(continuedRun.threadRelation, 'side')
  assert.equal(continuedRun.status, 'queued')

  // Primary Factory task's sourceEventId, attemptId, and status must stay completely untouched.
  const { rows: [factoryAfter] } = await pool.query<{ sourceEventId: string; attemptId: string; status: string }>(
    `SELECT "sourceEventId","attemptId",status FROM factory_tasks WHERE id=$1`,
    [factoryTaskId],
  )
  assert.deepEqual(factoryAfter, { sourceEventId: primarySourceEventId, attemptId, status: 'passed' })
  // Primary task latestTaskRun must still return rootId, never the side continuation.
  const { latestTaskRun } = await import('../lib/thread-dispatch.js')
  assert.equal((await latestTaskRun(pool, owner.id, issueId))?.id, rootId)
  // Even if the side continuation switches models, latestThreadRunModel for the primary task retains rootId's model.
  await pool.query(`UPDATE agent_runs SET "agentDefinition"=$2::jsonb WHERE id=$1`, [
    followUp.runId, JSON.stringify({ harness: 'codex', model: 'gpt-5.4-pro' }),
  ])
  const { latestThreadRunModel } = await import('../lib/computer/run-model.js')
  assert.equal((await latestThreadRunModel(pool, owner.id, issueId, agentId))?.model, 'gpt-5.4')
})

test('queued /compact preserves replay across jsonb key order, blocks Send Now without failing, and syncs control on edit', async () => {
  const { rootId, agentId } = await fixture()
  const deviceId = randomUUID(), repoId = randomUUID()
  const remote = 'https://github.com/acme/queue-ctrl.git'
  await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,harnesses) VALUES ($1,$2,'local-q','local',true,'[{"harness":"claude_code","installed":true}]'::jsonb)`, [deviceId, owner.id])
  await pool.query(`UPDATE agents SET "deviceId"=$2, harness='claude_code' WHERE id=$1`, [agentId, deviceId])
  await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)`, [repoId, deviceId, owner.id, remoteKey(remote), remote])
  await pool.query(`UPDATE agent_runs SET status='running',"deviceId"=$2,"deviceRepoId"=$3,"agentDefinition"=$4::jsonb WHERE id=$1`, [
    rootId, deviceId, repoId, JSON.stringify({ harness: 'claude_code', model: 'claude-sonnet-4-6' }),
  ])

  const { readRunChain } = await import('../lib/run-chain.js')
  const { queueThreadReply, readQueuedReplyReceipt, threadDeliveryView, deliverQueuedThreadReply, editQueuedThreadReply } = await import('../lib/thread-delivery-queue.js')
  const chain = await readRunChain(pool, owner.id, rootId)
  assert.ok(chain)

  const reqId = randomUUID()
  const control = { kind: 'compact' as const, instructions: 'Keep API decisions' }
  await queueThreadReply(pool, owner.id, chain, '/compact Keep API decisions', reqId, rootId, control)

  // Replay with keys in different JS order must match jsonb-stored control without submissionConflict.
  const reordered = { instructions: 'Keep API decisions', kind: 'compact' as const }
  const receipt = await readQueuedReplyReceipt(pool, owner.id, chain, '/compact Keep API decisions', reqId, rootId, reordered)
  assert.equal(receipt?.runId, rootId)

  // View exposes canSendNow: false for queued /compact.
  const viewBefore = await threadDeliveryView(pool, owner.id, chain.rootRunId, chain.latestRunId)
  assert.equal(viewBefore.queued.length, 1)
  const queueId = viewBefore.queued[0]!.id
  assert.equal(viewBefore.queued[0]!.canSendNow, false)

  // Send Now on queued /compact rejects without marking the queue entry failed.
  await assert.rejects(
    () => deliverQueuedThreadReply(pool, owner.id, rootId, queueId),
    (err: unknown) => err instanceof Error && 'code' in err && (err as { code?: string }).code === 'threadDeliveryUnavailable',
  )
  const { rows: [afterSendNow] } = await pool.query<{ status: string }>(`SELECT status FROM thread_queued_messages WHERE id=$1`, [queueId])
  assert.equal(afterSendNow.status, 'queued')

  // Editing into a blocked Claude slash command is refused without mutating text or control.
  const blockedEdit = await editQueuedThreadReply(pool, owner.id, rootId, queueId, '/login')
  assert.equal(blockedEdit, 'invalid')

  // Editing into plain text clears the stale /compact control atomically and restores canSendNow.
  const plainEdit = await editQueuedThreadReply(pool, owner.id, rootId, queueId, 'Summarize open questions')
  assert.equal(plainEdit, 'edited')
  const { rows: [controlAfter] } = await pool.query(`SELECT 1 FROM coordinator_events WHERE "userId"=$1 AND "dedupeKey"=$2`, [owner.id, `thread-queue-control:${queueId}`])
  assert.equal(controlAfter, undefined)
  const viewAfter = await threadDeliveryView(pool, owner.id, chain.rootRunId, chain.latestRunId)
  assert.equal(viewAfter.queued[0]!.text, 'Summarize open questions')
  assert.equal(viewAfter.queued[0]!.canSendNow, true)

  // Editing a reply queued with Send as text (`client_composed`) preserves literal delivery even if text starts with `/compact`.
  const literalReqId = randomUUID()
  await queueThreadReply(pool, owner.id, chain, '/compact refers to the command', literalReqId, rootId, { kind: 'client_composed' })
  const viewWithLiteral = await threadDeliveryView(pool, owner.id, chain.rootRunId, chain.latestRunId)
  const literalRow = viewWithLiteral.queued.find(row => row.requestId === literalReqId)
  assert.ok(literalRow)
  assert.equal(literalRow.canSendNow, true)
  const editedLiteral = await editQueuedThreadReply(pool, owner.id, rootId, literalRow.id, '/compact explains how compaction works')
  assert.equal(editedLiteral, 'edited')
  const { rows: [literalControl] } = await pool.query<{ kind: string }>(
    `SELECT payload->'threadQueuedControl'->>'kind' AS kind FROM coordinator_events WHERE "userId"=$1 AND "dedupeKey"=$2`,
    [owner.id, `thread-queue-control:${literalRow.id}`],
  )
  assert.equal(literalControl?.kind, 'client_composed')
})

