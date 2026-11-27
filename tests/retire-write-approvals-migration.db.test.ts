import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from './support/drop-test-database'
import { orderMigrations } from '../scripts/migration-order.mjs'

// ADR 2026-11-27-1615: the migration that retires write approvals runs on a
// fully migrated database, including a workspace whose account deletion is in
// progress (its policy row rejects every write), and is safe to run twice.
const MIGRATION = '20261127162323_retire_write_approvals.sql'
const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('retiring write approvals closes waiting proposals, rewrites ask to allow, skips guarded workspaces and reruns as a no-op', { skip: !url, timeout: 240_000 }, async () => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const name = `retire_writes_${randomUUID().replaceAll('-', '')}_e2e`
  let pool: Pool | undefined
  try {
    await createTestDatabase(admin, name, 'template0')
    const target = new URL(url!); target.pathname = `/${name}`
    pool = new Pool({ connectionString: target.toString(), max: 1 })
    const directory = new URL('../drizzle/', import.meta.url)
    const files = orderMigrations((await readdir(directory)).filter(file => file.endsWith('.sql')))
    assert.ok(files.includes(MIGRATION))
    for (const file of files.filter(file => file !== MIGRATION)) await pool.query(await readFile(new URL(file, directory), 'utf8'))
    const migration = await readFile(new URL(MIGRATION, directory), 'utf8')
    const run = async () => {
      const client = await pool!.connect()
      try { await client.query('BEGIN'); await client.query(migration); await client.query('COMMIT') }
      catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    }

    const owner = `retire-owner-${randomUUID()}`
    await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Retire fixture\',$2,true,now(),now())', [owner, `${owner}@example.invalid`])
    const [pending, running, done] = [randomUUID(), randomUUID(), randomUUID()]
    await pool.query(`INSERT INTO pending_actions(id,"userId",action,input,status) VALUES ($1,$4,'send_email','{}','pending'),($2,$4,'send_email','{}','running'),($3,$4,'app_tool_call','{}','done')`, [pending, running, done, owner])
    await pool.query(`INSERT INTO agent_kit_heads(owner_id,bot_key,external_write_permissions) VALUES ($1,'coordinator',$2)`, [owner, { send_email: 'ask', github: 'deny' }])
    const [open, deleting] = [randomUUID(), randomUUID()]
    for (const workspaceId of [open, deleting]) {
      await pool.query('INSERT INTO workspace_computer_policies("workspaceId",external_write_permissions) VALUES ($1,$2)', [workspaceId, { slack: 'ask', gmail: 'deny', notion: 'allow' }])
    }
    // The deleting workspace's policy row now refuses every write, as in production.
    await pool.query('INSERT INTO account_deletion_workspace_guards("workspaceId","jobId") VALUES ($1,$2)', [deleting, randomUUID()])
    await assert.rejects(pool.query('UPDATE workspace_computer_policies SET external_write_permissions=\'{}\' WHERE "workspaceId"=$1', [deleting]), { code: '55000', message: 'account_deletion_pending' })

    const policy = async (workspaceId: string) => (await pool!.query('SELECT external_write_permissions AS permissions, external_write_policy_version::text AS version FROM workspace_computer_policies WHERE "workspaceId"=$1', [workspaceId])).rows[0]
    const statuses = async () => Object.fromEntries((await pool!.query('SELECT id,status,error,"decidedAt" FROM pending_actions WHERE "userId"=$1', [owner])).rows.map(row => [row.id, { status: row.status, error: row.error, decidedAt: row.decidedAt }]))
    const head = async () => (await pool!.query('SELECT external_write_permissions AS permissions, external_write_policy_version::text AS version FROM agent_kit_heads WHERE owner_id=$1', [owner])).rows[0]

    for (let attempt = 1; attempt <= 2; attempt++) {
      await run()
      assert.deepEqual(await statuses(), {
        [pending]: { status: 'declined', error: 'approvalRetired', decidedAt: null },
        [running]: { status: 'running', error: null, decidedAt: null },
        [done]: { status: 'done', error: null, decidedAt: null },
      }, `attempt ${attempt}`)
      assert.deepEqual(await policy(open), { permissions: { slack: 'allow', gmail: 'deny', notion: 'allow' }, version: '1' }, `attempt ${attempt}: the version moves once`)
      assert.deepEqual(await policy(deleting), { permissions: { slack: 'ask', gmail: 'deny', notion: 'allow' }, version: '0' }, `attempt ${attempt}: a guarded workspace is left alone`)
      assert.deepEqual(await head(), { permissions: { send_email: 'allow', github: 'deny' }, version: '1' }, `attempt ${attempt}`)
    }
  } finally {
    await dropTestDatabase(admin, name, pool)
    await admin.end()
  }
})
