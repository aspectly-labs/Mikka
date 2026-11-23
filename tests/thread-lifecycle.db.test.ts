import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { pool } from '../lib/db'
import {
  bindSlackThread, createThreadShare, revokeThreadShares, deleteThread, listThreadChildren, moveThread,
  patchThread, restoreThread, sharedThread, spawnThread,
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

test('patch moves task binding and tags on the root; foreign tasks are refused', async () => {
  const { rootId, workspace } = await fixture()
  const otherIssue = await seedIssue(pool, outsider.id)
  const run = await patchThread(owner, rootId, { taskId: otherIssue, tags: ['review'] })
  assert.equal(run, 'forbidden')
  const next = await seedIssue(pool, owner.id, workspace.id)
  const patched = await patchThread(owner, rootId, { taskId: next, tags: ['a', 'b'] })
  assert.ok(patched && patched !== 'forbidden')
  assert.equal(patched.issueId, next)
  assert.deepEqual(patched.tags, ['a', 'b'])
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
  // the binding that steers the next continuation onto the cloud path.
  await pool.query(`UPDATE agent_runs SET status='succeeded' WHERE id=$1`, [queuedId])
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

  // Moving back to the Agent's own device drops the cloud binding, so the next
  // reply queues locally again.
  await pool.query(`UPDATE agents SET "deviceId"=$2 WHERE id=$1`, [agentId, deviceId])
  assert.equal(await moveThread(owner, rootId, { deviceId }), true)
  const { rows: [gone] } = await pool.query(`SELECT 1 FROM computer_run_bindings WHERE "runId"=$1`, [queuedId])
  assert.equal(gone, undefined)

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
