import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createRequestDatabaseScope } from './db/request-scope'

const url = process.env.E2E_DATABASE_URL
if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname) || !new URL(url).pathname.endsWith('_e2e')) throw new Error('An isolated loopback *_e2e database is required')
const schema = `needsyou_${randomUUID().replaceAll('-', '')}`
const admin = new Pool({ connectionString: url })
const target = new URL(url)
target.searchParams.set('options', `-c search_path=${schema}`)
const scope = createRequestDatabaseScope(target.toString())
const run = <T>(fn: () => T) => scope.run(fn)
before(async () => {
  mock.module('@/lib/pending-action-store', { namedExports: { listPendingActions: async () => [] } })
  mock.module('@/lib/tokens/scope', { namedExports: {
    namedOutsideToken: async () => false,
    pendingActionsOutsideToken: async () => new Set<string>(),
  } })
  mock.module('@/lib/factory/public-flow', { namedExports: { readFactoryFlowStates: async () => new Map() } })
  await admin.query(`CREATE SCHEMA ${schema}`)
  await run(async () => {
    const { pool } = await import('./db')
    await pool.query(`CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"workspaceId" uuid,
      "retryOf" uuid,"continuesRunId" uuid,"questionContinuation" jsonb,status text,"pauseReason" text,"updatedAt" timestamptz)`)
  })
})
after(async () => { mock.restoreAll(); await scope.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() })

const insertRun = (pool: { query: (s: string, v?: unknown[]) => Promise<unknown> }, row: {
  id: string; userId?: string; issueId?: string | null; workspaceId?: string | null
  retryOf?: string | null; continuesRunId?: string | null; originRunId?: string | null
  status?: string; pauseReason?: string | null
}) => pool.query(
  `INSERT INTO agent_runs(id,"userId","issueId","workspaceId","retryOf","continuesRunId","questionContinuation",status,"pauseReason","updatedAt")
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
  [row.id, row.userId ?? 'owner', row.issueId ?? null, row.workspaceId ?? null,
   row.retryOf ?? null, row.continuesRunId ?? null,
   row.originRunId ? JSON.stringify({ originRunId: row.originRunId }) : null,
   row.status ?? 'paused', row.pauseReason ?? 'quota_exhausted'])

test('limit items name the chain root across retryOf, continuesRunId and question origins', () => run(async () => {
  const { pool } = await import('./db')
  const { listNeedsYou } = await import('./needs-you')
  const issue = randomUUID(), otherIssue = randomUUID(), ws = randomUUID()
  const root = randomUUID(), retried = randomUUID(), resumed = randomUUID(), orphan = randomUUID()
  // A paused root run names itself.
  await insertRun(pool, { id: root, issueId: issue, workspaceId: ws })
  // A paused retry walks retryOf up to the same chain's root.
  await insertRun(pool, { id: retried, issueId: issue, workspaceId: ws, retryOf: root, status: 'paused' })
  // A question-resumed run walks questionContinuation.originRunId up to the root.
  await insertRun(pool, { id: resumed, issueId: issue, workspaceId: ws, originRunId: root })
  // An origin pointing at another task is outside the fence: the run is its own root.
  await insertRun(pool, { id: orphan, issueId: issue, workspaceId: ws, originRunId: randomUUID() })
  // ...and a real cross-task parent exists but must not be followed.
  const otherRoot = randomUUID(), moved = randomUUID()
  await insertRun(pool, { id: otherRoot, issueId: otherIssue, workspaceId: ws })
  await insertRun(pool, { id: moved, issueId: issue, workspaceId: ws, originRunId: otherRoot })
  const items = await listNeedsYou({ id: 'owner' })
  const byThread = new Map(items.filter(i => i.kind === 'limit').map(i => [i.threadId, i]))
  assert.ok(byThread.has(root), 'paused root names itself')
  assert.ok(!byThread.has(retried), 'retry collapses to the root')
  assert.ok(!byThread.has(resumed), 'question-resumed run collapses to the root')
  assert.equal(byThread.get(root)?.detail, 'quota_exhausted')
  assert.ok(byThread.has(orphan), 'dangling origin: the paused run is its own root')
  assert.ok(byThread.has(moved), 'cross-task origin is fenced: the paused run is its own root')
  assert.ok(!byThread.has(otherRoot), 'the other task\'s root is not claimed')
}))

test('quota items of other users and non-quota pauses are not listed', () => run(async () => {
  const { pool } = await import('./db')
  const { listNeedsYou } = await import('./needs-you')
  await insertRun(pool, { id: randomUUID(), userId: 'someone-else' })
  await insertRun(pool, { id: randomUUID(), userId: 'owner2', pauseReason: 'user_paused' })
  await insertRun(pool, { id: randomUUID(), userId: 'owner2', status: 'running' })
  const items = await listNeedsYou({ id: 'owner2' })
  assert.equal(items.filter(i => i.kind === 'limit').length, 0)
}))
