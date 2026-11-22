import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool } from '../lib/db'
import { seedAgent, seedIssue, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

async function setup() {
  const userId = await seedUser(pool, 'thread-sessions')
  const ws = await seedWorkspace(pool, userId, [{ userId, role: 'admin' }])
  const agent = await seedAgent(pool, userId)
  const issue = await seedIssue(pool, userId, ws.id)
  const runId = await seedRun(pool, { userId, agentId: agent, workspaceId: ws.id, issueId: issue })
  return { userId, workspaceId: ws.id, issueId: issue, runId }
}

async function mint(runId: string, userId: string, workspaceId: string, issueId: string, kind: 'terminal' | 'preview', name: string) {
  await pool.query(
    `INSERT INTO coding_review_sessions (id,kind,name,"taskId","runId","ownerId","workspaceId","deviceId","repoId","deviceTokenId","bindingId","sandboxId","machineEpoch","machineOperationId","credentialKind","credentialId","expiresAt",provider)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,'session',$14,clock_timestamp()+interval '2 minutes','e2b')`,
    [randomUUID(), kind, name, issueId, runId, userId, workspaceId, randomUUID(), randomUUID(), randomUUID(), 'a'.repeat(64), 'sandbox-x', randomUUID(), randomUUID()])
}

test('several named terminals coexist on one machine; same (runId,kind,name) is unique', async () => {
  const { userId, workspaceId, issueId, runId } = await setup()
  await mint(runId, userId, workspaceId, issueId, 'terminal', '')
  await mint(runId, userId, workspaceId, issueId, 'terminal', 'shell-2')
  await mint(runId, userId, workspaceId, issueId, 'terminal', 'shell-3')
  const { rows } = await pool.query(`SELECT name FROM coding_review_sessions WHERE "runId"=$1 AND kind='terminal' ORDER BY name`, [runId])
  assert.deepEqual(rows.map(r => r.name), ['', 'shell-2', 'shell-3'])
  await assert.rejects(() => mint(runId, userId, workspaceId, issueId, 'terminal', 'shell-2'), /unique|duplicate/i)
})

test('a preview session coexists with terminals; other kinds are independent', async () => {
  const { userId, workspaceId, issueId, runId } = await setup()
  await mint(runId, userId, workspaceId, issueId, 'terminal', 'shell-2')
  await mint(runId, userId, workspaceId, issueId, 'preview', '')
  const { rows: [count] } = await pool.query(`SELECT count(*)::int AS c FROM coding_review_sessions WHERE "runId"=$1`, [runId])
  assert.equal(count.c, 2)
})
