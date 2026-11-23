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

test('move retargets cloud ↔ device only for the owner, rebinding the repo onto the target', async () => {
  const { rootId, workspace } = await fixture()
  const sourceDevice = randomUUID(), deviceId = randomUUID(), cloudDevice = randomUUID()
  await pool.query(`INSERT INTO devices (id,"ownerId",name) VALUES ($1,$3,'src'),($2,$3,'box')`, [sourceDevice, deviceId, owner.id])
  await pool.query(`INSERT INTO devices (id,"ownerId",name,kind) VALUES ($1,$2,'cloud','cloud')`, [cloudDevice, owner.id])
  const remote = 'https://github.com/acme/app.git'
  const sourceRepo = randomUUID()
  await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)`, [sourceRepo, sourceDevice, owner.id, remoteKey(remote), remote])
  await pool.query(`UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3 WHERE id=$1`, [rootId, sourceDevice, sourceRepo])
  await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId","sandboxId","deviceId",state) VALUES ($1,$2,$3,$4,$5,'running')`, [workspace.id, owner.id, randomUUID(), `synthetic-${rootId.slice(0, 8)}`, cloudDevice])

  assert.equal(await moveThread(owner, rootId, { deviceId }), true)
  const { rows: [moved] } = await pool.query(
    `SELECT r."deviceId", r."deviceRepoId", r."machineAuthority", repo."deviceId" AS "repoDevice" FROM agent_runs r JOIN device_repos repo ON repo.id=r."deviceRepoId" WHERE r.id=$1`, [rootId])
  assert.equal(moved.deviceId, deviceId)
  assert.equal(moved.repoDevice, deviceId)
  assert.equal(moved.machineAuthority, false)
  assert.notEqual(moved.deviceRepoId, sourceRepo)

  assert.equal(await moveThread(owner, rootId, { deviceId: 'cloud' }), true)
  const { rows: [back] } = await pool.query(
    `SELECT r."deviceId", r."machineAuthority", repo."deviceId" AS "repoDevice" FROM agent_runs r JOIN device_repos repo ON repo.id=r."deviceRepoId" WHERE r.id=$1`, [rootId])
  assert.equal(back.deviceId, cloudDevice)
  assert.equal(back.repoDevice, cloudDevice)
  assert.equal(back.machineAuthority, true)

  // A thread without a repository cannot run anywhere else — the move refuses.
  const bare = await fixture()
  assert.equal(await moveThread(owner, bare.rootId, { deviceId }), null)
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
