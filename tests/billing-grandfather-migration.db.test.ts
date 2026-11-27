import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { dbUrl } from './support/workspace-admin-db'

// 20261126233650 converts card-verification allowances into grandfather grants. Run twice (a re-run, or a deploy
// that replays it) it must convert each workspace exactly once and never zero an allowance credited afterwards.
test('the grandfather migration converts once and keeps an allowance credited after it', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const admin = new Pool({ connectionString: dbUrl, max: 1 })
  const schema = `grandfather_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: dbUrl, max: 1, options: `-c search_path=${schema}` })
  t.after(async () => {
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  })
  // The tables the migration reads and writes, as the earlier migrations leave them.
  await pool.query(`
    CREATE TABLE hosted_allowances ("workspaceId" uuid PRIMARY KEY, remaining bigint NOT NULL CHECK (remaining >= 0));
    CREATE TABLE hosted_usage (id text PRIMARY KEY);
    CREATE TABLE workspace_billing ("workspaceId" uuid PRIMARY KEY);
    CREATE TABLE workspace_credit_grants (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL,
      bucket text NOT NULL CHECK (bucket IN ('plan','purchased')), points integer NOT NULL, reason text NOT NULL,
      "externalId" text NOT NULL UNIQUE, "amountCents" integer, currency text, "expiresAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now())`)
  const migration = await readFile(new URL('../drizzle/20261126233650_billing_new_pricing_credits.sql', import.meta.url), 'utf8')
  const [first, second, empty] = [randomUUID(), randomUUID(), randomUUID()]
  await pool.query('INSERT INTO hosted_usage (id) VALUES ($1)', ['existing-usage-row'])
  await pool.query('INSERT INTO hosted_allowances ("workspaceId",remaining) VALUES ($1,123456),($2,0)', [first, empty])
  const state = async () => ({
    allowances: Object.fromEntries((await pool.query<{ workspaceId: string; remaining: string }>(
      'SELECT "workspaceId",remaining::text FROM hosted_allowances')).rows.map(row => [row.workspaceId, Number(row.remaining)])),
    grants: (await pool.query<{ workspaceId: string; points: number; reason: string; amountCents: number; expiresAt: Date | null }>(
      'SELECT "workspaceId",points,reason,"amountCents","expiresAt" FROM workspace_credit_grants ORDER BY "createdAt","workspaceId"')).rows,
  })

  await pool.query(migration)
  const afterFirst = await state()
  assert.deepEqual(afterFirst.allowances, { [first]: 0, [empty]: 0 })
  assert.deepEqual(afterFirst.grants, [{ workspaceId: first, points: 13, reason: 'allowance_grandfather', amountCents: 0, expiresAt: null }])

  // After the migration: a refund credits the converted workspace's allowance, and a new workspace has one.
  await pool.query('UPDATE hosted_allowances SET remaining=remaining+50000 WHERE "workspaceId"=$1', [first])
  await pool.query('INSERT INTO hosted_allowances ("workspaceId",remaining) VALUES ($1,20000)', [second])
  await pool.query(migration)
  const afterSecond = await state()
  assert.equal(afterSecond.allowances[first], 50_000, 'the refund credited after the first run is kept')
  assert.equal(afterSecond.allowances[second], 0)
  assert.equal(afterSecond.grants.filter(grant => grant.workspaceId === first).length, 1)
  assert.deepEqual(afterSecond.grants.find(grant => grant.workspaceId === second)?.points, 2)

  // The check on the new column is present and validated, and existing rows took the default.
  const { rows: [constraint] } = await pool.query<{ convalidated: boolean }>(
    `SELECT convalidated FROM pg_constraint WHERE conname='hosted_usage_purchased_allocations_object' AND conrelid=to_regclass('hosted_usage')`)
  assert.equal(constraint?.convalidated, true)
  assert.deepEqual((await pool.query('SELECT "purchasedAllocations" FROM hosted_usage')).rows, [{ purchasedAllocations: {} }])
  await assert.rejects(pool.query(`INSERT INTO hosted_usage (id,"purchasedAllocations") VALUES ('array-row','[]')`), /hosted_usage_purchased_allocations_object/)
})
