import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl } from './support/workspace-admin-db'

const migrations = [
  '20261128172400_audit_delivery_guard_main.sql',
  '20261128172401_audit_delivery_guard_workspace.sql',
]
const apply = async (database: Pool, name: string) => database.query(await readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'))

const columns = '("workspaceId" uuid NOT NULL, id uuid NOT NULL, "actorName" text)'
const guard = (table: string) => `CREATE TRIGGER account_deletion_workspace_guard BEFORE INSERT OR UPDATE
  ON ${table} FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_workspace_write()`
const shapes: Array<{ name: string; reject: boolean; cloned?: boolean; sql: string }> = [
  { name: 'partition parent', reject: true, cloned: true, sql: `
    CREATE TABLE workspace_audit_events ${columns} PARTITION BY HASH ("workspaceId");
    CREATE TABLE audit_partition PARTITION OF workspace_audit_events FOR VALUES WITH (MODULUS 1, REMAINDER 0);
    ${guard('workspace_audit_events')};` },
  { name: 'partition parent without a guard', reject: true, sql: `
    CREATE TABLE workspace_audit_events ${columns} PARTITION BY HASH ("workspaceId");
    CREATE TABLE audit_partition PARTITION OF workspace_audit_events FOR VALUES WITH (MODULUS 1, REMAINDER 0);` },
  { name: 'partition child', reject: true, cloned: true, sql: `
    CREATE TABLE audit_parent ${columns} PARTITION BY HASH ("workspaceId");
    CREATE TABLE workspace_audit_events PARTITION OF audit_parent FOR VALUES WITH (MODULUS 1, REMAINDER 0);
    ${guard('audit_parent')};` },
  { name: 'inheritance parent', reject: true, sql: `
    CREATE TABLE workspace_audit_events ${columns};
    CREATE TABLE inherited_audit () INHERITS (workspace_audit_events);
    ${guard('workspace_audit_events')}; ${guard('inherited_audit')};` },
  { name: 'inheritance child', reject: true, sql: `
    CREATE TABLE audit_parent ${columns};
    CREATE TABLE workspace_audit_events () INHERITS (audit_parent);
    ${guard('audit_parent')}; ${guard('workspace_audit_events')};` },
  { name: 'view without a guard', reject: true, sql: `
    CREATE VIEW workspace_audit_events AS SELECT NULL::uuid AS "workspaceId", NULL::uuid AS id, NULL::text AS "actorName";` },
  { name: 'ordinary table without a guard', reject: false, sql: `CREATE TABLE workspace_audit_events ${columns};` },
  { name: 'missing table', reject: false, sql: '' },
]

async function snapshot(database: Pool) {
  const relations = (await database.query(`SELECT c.relname, c.relkind, c.relispartition,
      c.oid::text AS relation_id, t.oid::text AS trigger_id, t.tgname, t.tgtype, t.tgenabled,
      t.tgattr::text AS columns, t.tgparentid::text AS parent_trigger,
      pg_get_triggerdef(t.oid) AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_trigger t ON t.tgrelid=c.oid AND NOT t.tgisinternal
    WHERE n.nspname=current_schema()
    ORDER BY c.relname,t.tgname`)).rows
  const inheritance = (await database.query(`SELECT child.relname AS child, parent.relname AS parent
    FROM pg_inherits i JOIN pg_class child ON child.oid=i.inhrelid
    JOIN pg_class parent ON parent.oid=i.inhparent
    JOIN pg_namespace n ON n.oid=child.relnamespace
    WHERE n.nspname=current_schema() ORDER BY child.relname,parent.relname`)).rows
  const functionDefinition = (await database.query("SELECT pg_get_functiondef('mikka_account_guard_workspace_write()'::regprocedure) AS definition")).rows[0].definition
  return { relations, inheritance, functionDefinition }
}

test('audit guard corrections preserve deletion barriers and unknown PostgreSQL structures', { skip: !dbUrl }, async t => {
  const main = new Pool({ connectionString: dbUrl, max: 1 })
  t.after(() => main.end())
  const version = Number((await main.query('SHOW server_version_num')).rows[0].server_version_num)
  assert.ok(version >= 170000 && version < 180000, 'Audit migration acceptance uses PostgreSQL 17')
  async function withSchema(run: (database: Pool) => Promise<void>) {
    const schema = `audit_guard_upgrade_${randomUUID().replaceAll('-', '')}`
    await main.query(`CREATE SCHEMA ${schema}`)
    const database = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}`, max: 1 })
    try { await run(database) }
    finally { await database.end(); await main.query(`DROP SCHEMA ${schema} CASCADE`) }
  }

  await t.test('fresh shared-target order and both legacy targets preserve the real guard function and business writes', async () => {
    await withSchema(async database => {
      // A split workspace target has no audit sink. Do not create one or a
      // replacement function merely to make the corrective migration succeed.
      for (const migration of migrations) await apply(database, migration)
      assert.equal((await database.query("SELECT to_regclass('workspace_audit_events') relation")).rows[0].relation, null)
      assert.equal((await database.query("SELECT to_regprocedure('mikka_account_guard_workspace_write()') function")).rows[0].function, null)
      await apply(database, '20261030204833_workspace_audit_events.sql')
      await database.query('CREATE TABLE guarded_business ("workspaceId" uuid NOT NULL)')
      // The main-target correction runs before the historical workspace-target
      // migration when both targets share the same fresh database.
      await apply(database, migrations[0])
      await apply(database, '20261031050732_workspace_deletion_guards.sql')
      const workspaceId = randomUUID()
      await database.query('INSERT INTO account_deletion_workspace_guards("workspaceId","jobId") VALUES($1,$2)', [workspaceId, randomUUID()])
      const definition = async () => (await database.query("SELECT pg_get_functiondef('mikka_account_guard_workspace_write()'::regprocedure) body")).rows[0].body
      const before = await definition()
      const append = () => database.query('INSERT INTO workspace_audit_events("workspaceId","actorType","actorName",action,category) VALUES($1,\'system\',\'Mikka\',\'auth.sign_in_failed\',\'security\') RETURNING id', [workspaceId])
      await assert.rejects(append(), { code: '55000' })
      await apply(database, migrations[1])
      const id = (await append()).rows[0].id
      const assertBarriers = async () => {
        await assert.rejects(database.query('INSERT INTO guarded_business("workspaceId") VALUES($1)', [workspaceId]), { code: '55000' })
        await assert.rejects(database.query('UPDATE workspace_audit_events SET "targetLabel"=\'changed\' WHERE id=$1', [id]), { code: '55000' })
        assert.equal(await definition(), before)
        assert.deepEqual((await database.query("SELECT tgtype FROM pg_trigger WHERE tgrelid='workspace_audit_events'::regclass AND tgname='account_deletion_workspace_guard'")).rows, [{ tgtype: 19 }])
      }
      await assertBarriers()
      // Restore the real historical INSERT/UPDATE guard to exercise each
      // target's upgrade independently, then verify repeated application too.
      for (const migration of migrations) {
        await database.query('CREATE OR REPLACE TRIGGER account_deletion_workspace_guard BEFORE INSERT OR UPDATE ON workspace_audit_events FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_workspace_write()')
        await assert.rejects(append(), { code: '55000' })
        await apply(database, migration)
        await append()
        await assertBarriers()
        await apply(database, migration)
        await assertBarriers()
      }
      const triggerDefinition = async () => (await database.query("SELECT pg_get_triggerdef(oid) body FROM pg_trigger WHERE tgrelid='workspace_audit_events'::regclass AND tgname='account_deletion_workspace_guard'")).rows[0].body
      for (const migration of migrations) {
        await database.query('CREATE OR REPLACE TRIGGER account_deletion_workspace_guard BEFORE UPDATE OF "actorName" ON workspace_audit_events FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_workspace_write()')
        const columnGuard = await triggerDefinition()
        await assert.rejects(apply(database, migration), /audit_delivery_guard_unexpected/)
        await database.query('ROLLBACK')
        assert.equal(await triggerDefinition(), columnGuard, 'Unknown column-scoped guards remain byte-for-byte unchanged')
      }
      await database.query('CREATE OR REPLACE TRIGGER account_deletion_workspace_guard BEFORE UPDATE ON workspace_audit_events FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_workspace_write()')
      await database.query('ALTER TABLE workspace_audit_events DISABLE TRIGGER account_deletion_workspace_guard')
      await assert.rejects(apply(database, migrations[0]), /audit_delivery_guard_unexpected/)
      await database.query('ROLLBACK')
      assert.equal((await database.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='workspace_audit_events'::regclass AND tgname='account_deletion_workspace_guard'")).rows[0].tgenabled, 'D')
      assert.equal(await definition(), before)
    })
  })

  for (const migration of migrations) for (const shape of shapes) {
    await t.test(`${migration}: ${shape.name}`, async () => {
      await withSchema(async database => {
        // Only this structural fixture uses a minimal function. The preceding
        // case executes the actual historical guard and SQLSTATE 55000.
        await database.query(`CREATE FUNCTION mikka_account_guard_workspace_write() RETURNS trigger
          LANGUAGE plpgsql AS $fixture$ BEGIN RETURN NEW; END $fixture$`)
        if (shape.sql) await database.query(shape.sql)
        const original = await snapshot(database)
        if (shape.cloned) {
          assert.equal(original.relations.filter(row => row.parent_trigger && row.parent_trigger !== '0').length, 1,
            'The fixture contains a native PostgreSQL child trigger clone')
        }
        if (shape.reject) {
          await assert.rejects(apply(database, migration), { code: 'P0001', message: 'audit_delivery_guard_unexpected' })
          await database.query('ROLLBACK')
        } else await apply(database, migration)
        assert.deepEqual(await snapshot(database), original,
          'Parent/child trigger definitions, inheritance and the guard function remain byte-for-byte unchanged')
      })
    })
  }
})
