// Mirrors mikka-cloud operations/business-api/pipeline-migrations.test.mjs (the deploy-side
// copy of automatic-migration-sql.mjs). The deploy fixtures are the product migrations named
// below, byte for byte; the staging-ledger test stays deploy-only.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertAdditiveSql, assertAutomaticSql } from './automatic-migration-sql.mjs'
import { readFileSync } from 'node:fs'

test('new tables with FK ON DELETE CASCADE and ordinary checks are expansion, not a DELETE statement', () => {
  // The candidate's pull_pins/saved_views migration uses this exact grammar.
  const sql = `-- target: MIKKA_DATABASE_URL
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS pull_pins (
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  "pullKey" text NOT NULL CHECK ("pullKey" ~ '^https://github\\.com/[a-z0-9_.-]+/[a-z0-9_.-]+/pull/[1-9][0-9]{0,9}$'),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "workspaceId", "pullKey")
);
CREATE TABLE IF NOT EXISTS saved_views (
  id uuid PRIMARY KEY,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('pulls', 'threads', 'tasks')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  filters jsonb NOT NULL CHECK (jsonb_typeof(filters) = 'object' AND pg_column_size(filters) <= 8192),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("ownerId", "workspaceId", scope, name)
);`
  assert.equal(assertAdditiveSql(sql), 3)
})

test('quoted comment text cannot hide a following destructive or procedural statement', () => {
  const rejected = [
    "SELECT '--'; DROP TABLE sample;",
    "CREATE TABLE fresh (value text DEFAULT '--'); DROP TABLE sample;",
    "CREATE TABLE fresh (value text DEFAULT '/*'); DELETE FROM sample;",
    "CREATE TABLE fresh (value text DEFAULT E'escaped\\\' --;'); DROP TABLE sample;",
    "DO $$ BEGIN EXECUTE 'DR'||'OP TABLE sample'; END $$;",
    "CALL application_backfill();",
    "UPDATE sample SET amount=0;",
    "INSERT INTO sample VALUES (1);",
    "WITH deleted AS (DELETE FROM sample RETURNING *) SELECT * FROM deleted;",
    "CREATE OR REPLACE FUNCTION changed() RETURNS void AS $$ BEGIN DELETE FROM sample; END $$ LANGUAGE plpgsql;",
    "CREATE TABLE saved AS SELECT destructive_function();",
    "ALTER TABLE sample DROP COLUMN old;",
    "ALTER TABLE sample ALTER COLUMN old TYPE text;",
    "ALTER TABLE sample ADD CONSTRAINT new_rule CHECK (old > 0);",
    "ALTER TABLE sample ADD COLUMN added integer CHECK (old > 0);",
    "ALTER TABLE sample ADD COLUMN required text NOT NULL;",
    "ALTER TABLE sample ADD COLUMN side_effect text DEFAULT application_backfill();",
    "ALTER TABLE sample ADD COLUMN side_effect text DEFAULT 'x'::custom_type;",
    "ALTER TABLE sample ADD COLUMN side_effect integer DEFAULT 1 + CURRENT_USER::custom_domain;",
    "ALTER TABLE sample ADD COLUMN side_effect custom_domain;",
    "ALTER TABLE sample ADD COLUMN side_effect public.text;",
    "ALTER TABLE sample ADD COLUMN side_effect \"custom_type\" DEFAULT 'x';",
    "ALTER TABLE sample ADD COLUMN side_effect text DEFAULT 'x' COLLATE custom_collation;",
    "ALTER TABLE sample ADD COLUMN side_effect text DEFAULT 'x' DEFAULT 'y';",
    "ALTER TABLE sample ADD COLUMN side_effect text NULL NOT NULL DEFAULT 'x';",
    "CREATE INDEX ix ON sample (application_backfill());",
    "CREATE INDEX ix ON sample (old custom_opclass);",
    "CREATE INDEX ix ON sample (old \"custom_opclass\");",
    "CREATE INDEX ix ON sample (old COLLATE custom_collation);",
    "CREATE INDEX ix ON sample (old DESC custom_opclass);",
    "CREATE INDEX ix ON sample (old NULLS FIRST,);",
    "CREATE UNIQUE INDEX ix ON sample (old);",
    "SET LOCAL standard_conforming_strings = 'off';",
    "SET LOCAL lock_timeout = '0';",
  ]
  for (const sql of rejected) assert.throws(() => assertAdditiveSql(sql), undefined, sql)
})

test('the automatic subset recognizes literals, quoted identifiers, nested comments and multiple ADD clauses without rewriting SQL', () => {
  const accepted = [
    "/* outer /* nested */ done */ CREATE TABLE fresh (value text DEFAULT '-- ; DROP TABLE inert');",
    "CREATE TABLE fresh (\"DROP\" text, value text DEFAULT E'escaped\\\' -- ;');",
    "CREATE TABLE fresh (\"a\"\"b\" text DEFAULT 'can''t --;');",
    "ALTER TABLE sample ADD COLUMN IF NOT EXISTS note text, ADD COLUMN enabled boolean NOT NULL DEFAULT false;",
    "ALTER TABLE sample ADD COLUMN value text[] NOT NULL DEFAULT '{}';",
    "ALTER TABLE sample ADD COLUMN amount pg_catalog.numeric(10, 2) DEFAULT 0 NOT NULL, ADD COLUMN entries uuid[][] NULL;",
    "ALTER TABLE sample ADD COLUMN created_at timestamp(3) with time zone, ADD COLUMN note character varying(80), ADD COLUMN rate double precision;",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS sample_note ON public.sample (note, created_at DESC);",
    "CREATE INDEX sample_note ON public.sample (note ASC NULLS FIRST, created_at DESC NULLS LAST);",
    "CREATE TYPE public.example AS ENUM ('first', 'second'); ALTER TYPE public.example ADD VALUE IF NOT EXISTS 'third' AFTER 'second';",
  ]
  for (const sql of accepted) {
    const before = Buffer.from(sql)
    assert.ok(assertAdditiveSql(sql) > 0)
    assert.deepEqual(Buffer.from(sql), before)
  }
  for (const sql of ["CREATE TABLE fresh (value text DEFAULT 'unterminated);", '/* unterminated',
    'CREATE TABLE fresh (value text;', 'CREATE TABLE fresh (value text));',
    "CREATE TABLE fresh (value text DEFAULT 'ambiguous\\'); DROP TABLE sample; --')"])
    assert.throws(() => assertAdditiveSql(sql))
})

test('new trigger functions, their triggers and indexes on a new table run automatically', () => {
  // The shape of the product's 20261124035101_mobile_refresh_tokens.sql.
  const sql = readFileSync(new URL('../drizzle/20261124035101_mobile_refresh_tokens.sql', import.meta.url), 'utf8')
  assert.equal(assertAdditiveSql(sql), 13)
})

test('functions, triggers and unique or partial indexes stay narrow', () => {
  const fn = (name, body = 'BEGIN RETURN NULL; END;') =>
    `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ ${body} $$;`
  const rejected = [
    // A function no trigger in this migration runs, or one that is not a trigger function.
    fn('orphan'),
    "CREATE FUNCTION helper() RETURNS void LANGUAGE sql AS $$ DELETE FROM sample $$; CREATE TRIGGER t AFTER INSERT ON sample EXECUTE FUNCTION helper();",
    fn('f') + " CREATE TRIGGER t AFTER INSERT ON sample FOR EACH ROW EXECUTE FUNCTION f(); DROP TRIGGER IF EXISTS other ON sample;",
    // A trigger on an existing table that runs an existing function.
    "CREATE TRIGGER t AFTER INSERT ON sample FOR EACH ROW EXECUTE FUNCTION existing();",
    "DROP TRIGGER IF EXISTS t ON sample;",
    "DROP TRIGGER t ON sample; " + fn('f') + " CREATE TRIGGER t AFTER INSERT ON sample EXECUTE FUNCTION f();",
    fn('f') + " CREATE TRIGGER t AFTER TRUNCATE ON sample EXECUTE FUNCTION f();",
    fn('f') + " CREATE TRIGGER t AFTER INSERT ON sample FOR EACH ROW WHEN (side_effect(NEW.id)) EXECUTE FUNCTION f();",
    fn('f') + " CREATE TRIGGER t AFTER INSERT ON sample FOR EACH ROW EXECUTE FUNCTION f(other());",
    "CREATE OR REPLACE VIEW v AS SELECT 1;",
    "DO $$ BEGIN DELETE FROM sample; END $$;",
    "CREATE TABLE fresh (value text DEFAULT $$x$$);",
    // Unique and partial indexes on existing rows.
    "CREATE UNIQUE INDEX ix ON sample (old);",
    "CREATE INDEX ix ON sample (old) WHERE old IS NOT NULL;",
    "CREATE TABLE fresh (id uuid); CREATE INDEX ix ON fresh (id) WHERE side_effect(id);",
    "CREATE TABLE fresh (id uuid); CREATE INDEX ix ON fresh (id) WHERE id::text = 'x';",
    "CREATE OR REPLACE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END;",
  ]
  for (const sql of rejected) assert.throws(() => assertAdditiveSql(sql), undefined, sql)
  const accepted = [
    "CREATE TABLE fresh (id uuid, owner text); CREATE UNIQUE INDEX IF NOT EXISTS fresh_owner ON public.fresh (owner); CREATE INDEX fresh_live ON fresh (id) WHERE owner IS NOT NULL;",
    "CREATE TABLE fresh (id uuid); DROP TRIGGER IF EXISTS guard ON fresh; CREATE TRIGGER guard BEFORE INSERT ON fresh FOR EACH ROW EXECUTE FUNCTION existing_guard('id');",
    fn('f', 'BEGIN UPDATE fresh SET x = 1; RETURN NULL; END;') + ' CREATE TRIGGER t BEFORE UPDATE OF "expiresAt" OR DELETE ON session FOR EACH ROW WHEN (NEW."expiresAt" > OLD."expiresAt") EXECUTE FUNCTION f();',
  ]
  for (const sql of accepted) assert.ok(assertAdditiveSql(sql) > 0, sql)
})

test('a data migration runs automatically only when its reviewed PR marked it', () => {
  const data = "SET LOCAL lock_timeout = '5s';\nDROP INDEX IF EXISTS old_unique;\nUPDATE sample SET flag = true WHERE flag = false;"
  assert.throws(() => assertAutomaticSql('20261201000000_backfill.sql', data))
  assert.equal(assertAutomaticSql('20261201000000_backfill.sql', '-- target: MIKKA_DATABASE_URL\n-- migrate: reviewed-data #3300 backfill sample.flag\n' + data), 'reviewed-data')
  // The marker needs a PR number and a reason, and a contract keeps its owner window.
  assert.throws(() => assertAutomaticSql('x.sql', '-- migrate: reviewed-data\n' + data))
  assert.throws(() => assertAutomaticSql('x.sql', '-- migrate: contract #1 old readers retired\n-- migrate: reviewed-data #2 drop\nALTER TABLE sample DROP COLUMN old;'))
  // Additive SQL needs no marker.
  assert.equal(assertAutomaticSql('x.sql', 'CREATE TABLE fresh (id uuid);'), 'additive')

  // The one data migration published before the marker existed is bound to its exact bytes.
  const published = readFileSync(new URL('../drizzle/20261124010135_multi_api_keys_and_default_effort.sql', import.meta.url), 'utf8')
  assert.equal(assertAutomaticSql('20261124010135_multi_api_keys_and_default_effort.sql', published), 'reviewed-data')
  assert.throws(() => assertAutomaticSql('20261124010135_multi_api_keys_and_default_effort.sql', published + '\nDELETE FROM model_api_keys;'))
  assert.throws(() => assertAutomaticSql('20261124020000_other.sql', published))
})
