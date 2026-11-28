import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool } from '../lib/db'
import { getThreadMachineDetail, listThreadUploads, threadUploadDownloadUrl } from '../lib/thread-workspace'
import { seedAgent, seedIssue, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

async function setup() {
  const userId = await seedUser(pool, 'thread-workspace')
  const ws = await seedWorkspace(pool, userId, [{ userId, role: 'admin' }])
  const agent = await seedAgent(pool, userId)
  const issue = await seedIssue(pool, userId, ws.id)
  const runId = await seedRun(pool, { userId, agentId: agent, workspaceId: ws.id, issueId: issue })
  return { userId, workspaceId: ws.id, issueId: issue, runId }
}

async function seedUpload(runId: string, userId: string, name = 'spec.pdf') {
  const id = randomUUID()
  await pool.query(
    `INSERT INTO chat_attachments (id,"userId","runId",name,"mediaType",size,state,sha256,"storageKey","usedAt")
     VALUES ($1,$2,$3,$4,'application/pdf',1024,'ready',$5,$6,now())`,
    [id, userId, runId, name, 'a'.repeat(64), `chat/${id}`])
  return id
}

test('listThreadUploads returns the chain uploads; an outsider sees none', async () => {
  const { userId, runId } = await setup()
  const id = await seedUpload(runId, userId)
  const uploads = await listThreadUploads(pool, userId, [runId])
  assert.equal(uploads.length, 1)
  assert.equal(uploads[0]!.id, id)
  assert.equal(uploads[0]!.name, 'spec.pdf')
  const outsider = await seedUser(pool, 'thread-workspace-out')
  assert.equal((await listThreadUploads(pool, outsider, [runId])).length, 0)
})

test('threadUploadDownloadUrl signs only a file on the chain and owner', async () => {
  const { userId, runId } = await setup()
  const id = await seedUpload(runId, userId)
  // A file on a different run of the same owner is not reachable here.
  const otherRun = await seedRun(pool, { userId, agentId: (await pool.query('SELECT "agentId" FROM agent_runs WHERE id=$1', [runId])).rows[0]!.agentId, workspaceId: (await setup()).workspaceId })
  const foreign = await seedUpload(otherRun, userId, 'other.pdf')
  assert.equal(await threadUploadDownloadUrl(pool, userId, [runId], foreign), null)
  const outsider = await seedUser(pool, 'thread-workspace-out2')
  assert.equal(await threadUploadDownloadUrl(pool, outsider, [runId], id), null)
  // The real file resolves to a signed URL or null when object storage is off.
  const got = await threadUploadDownloadUrl(pool, userId, [runId], id)
  assert.ok(got !== null && 'downloadUrl' in got)
})

test('removed and unfinished uploads stay invisible', async () => {
  const { userId, runId } = await setup()
  await seedUpload(runId, userId)
  const uploading = randomUUID()
  await pool.query(`INSERT INTO chat_attachments (id,"userId","runId",name,"mediaType",size) VALUES ($1,$2,$3,'draft.bin','application/octet-stream',10)`, [uploading, userId, runId])
  const removed = randomUUID()
  await pool.query(`INSERT INTO chat_attachments (id,"userId","runId",name,"mediaType",size,state,sha256,"storageKey","removedAt") VALUES ($1,$2,$3,'gone.bin','application/octet-stream',10,'ready',$4,$5,now())`, [removed, userId, runId, 'b'.repeat(64), `chat/${removed}`])
  const uploads = await listThreadUploads(pool, userId, [runId])
  assert.equal(uploads.length, 1)
  assert.equal(uploads[0]!.name, 'spec.pdf')
})

test('getThreadMachineDetail returns the machine row for the owner', async () => {
  const { userId, workspaceId, runId } = await setup()
  await pool.query(
    `INSERT INTO thread_machines ("runId","workspaceId","ownerId","sandboxId","snapshotId","operationId",state)
     VALUES ($1,$2,$3,$4,$5,$6,'running')`,
    [runId, workspaceId, userId, 'sandbox-1', 'snap-1', randomUUID()])
  const detail = await getThreadMachineDetail(pool, userId, workspaceId, runId)
  assert.equal(detail?.state, 'running')
  assert.equal(detail?.spec.sandboxId, 'sandbox-1')
  assert.equal(detail?.spec.snapshotId, 'snap-1')
  assert.ok(detail?.metrics.createdAt)
  const outsider = await seedUser(pool, 'thread-workspace-out3')
  assert.equal(await getThreadMachineDetail(pool, outsider, workspaceId, runId), null)
  // No machine at all -> null, never an error.
  const { userId: u2, workspaceId: w2, runId: r2 } = await setup()
  assert.equal(await getThreadMachineDetail(pool, u2, w2, r2), null)
})
