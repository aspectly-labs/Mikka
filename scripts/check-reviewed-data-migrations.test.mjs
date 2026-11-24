import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blobId, checkReviewedDataMigrations, reviewedDataProblem } from './check-reviewed-data-migrations.mjs'
import { buildMigrationExecution } from './release/migration-inputs.mjs'

const name = '20261201000000_backfill_flag.sql'
const data = "-- target: MIKKA_DATABASE_URL\nSET LOCAL lock_timeout = '5s';\nUPDATE sample SET flag = true WHERE flag = false;\n"
const marked = (marker) => `-- target: MIKKA_DATABASE_URL\n${marker}\nSET LOCAL lock_timeout = '5s';\nUPDATE sample SET flag = true WHERE flag = false;\n`
const schema = '-- target: MIKKA_DATABASE_URL\nCREATE TABLE IF NOT EXISTS fresh (id uuid PRIMARY KEY, note text);\nALTER TABLE sample ADD COLUMN IF NOT EXISTS note text;\n'
const old = { name: '20261023010000_old_backfill.sql', content: 'UPDATE sample SET flag = true;\n' }
const main = new Map([[old.name, blobId(old.content)]])
const check = (...files) => checkReviewedDataMigrations([old, ...files], main)

test('a new data-changing migration without the marker fails', () => {
  for (const sql of [data, 'DELETE FROM sample WHERE stale;', 'INSERT INTO sample (id) SELECT id FROM other;', 'DROP INDEX IF EXISTS old_unique;',
    'DO $$ BEGIN UPDATE sample SET flag = true; END $$;', 'CREATE UNIQUE INDEX ix ON sample (owner);', 'ALTER TABLE sample ALTER COLUMN old TYPE text;']) {
    const problems = check({ name, content: sql })
    assert.equal(problems.length, 1, sql)
    assert.match(problems[0], /-- migrate: reviewed-data #<PR 编号>/)
  }
})

test('a valid reviewed-data marker passes', () => {
  assert.deepEqual(check({ name, content: marked('-- migrate: reviewed-data #3300 backfill sample.flag') }), [])
  assert.deepEqual(check({ name, content: marked('--migrate:   REVIEWED-DATA   #1 flip flags') }), [], 'same case and spacing rules as the deploy side')
})

test('a schema-only (additive) migration needs no marker', () => {
  assert.deepEqual(check({ name, content: schema }), [])
  assert.deepEqual(check({ name, content: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS sample_note ON sample (note);' }), [])
})

test('a malformed marker fails, even on additive SQL', () => {
  for (const marker of ['-- migrate: reviewed-data', '-- migrate: reviewed-data #3300', '-- migrate: reviewed-data 3300 backfill',
    '-- migrate: reviewed-data #0 backfill', '-- migrate: reviewed-data #03300 backfill', '-- migrate: reviewed-data #abc backfill']) {
    assert.match(check({ name, content: marked(marker) }).join(), /标记格式不对/, marker)
    assert.match(check({ name, content: `${marker}\n${schema}` }).join(), /标记格式不对/, marker)
  }
})

test('a marker after the first statement does not count', () => {
  const late = "SET LOCAL lock_timeout = '5s';\n-- migrate: reviewed-data #3300 backfill\nUPDATE sample SET flag = true;\n"
  assert.match(check({ name, content: late }).join(), /标记必须放在文件开头/)
  assert.match(check({ name, content: "SELECT '-- migrate: reviewed-data #3300 not a header';\nUPDATE sample SET flag = true;" }).join(), /超出自动迁移范围/)
})

test('a marked file must still be SQL the deploy side can read', () => {
  assert.match(check({ name, content: marked('-- migrate: reviewed-data #3300 backfill') + "SELECT 'unterminated;\n" }).join(), /仍无法解析/)
})

test('contract migrations keep their owner window and are not this check\'s concern', () => {
  assert.deepEqual(check({ name, content: '-- migrate: contract #2896 readers retired\nALTER TABLE sample DROP COLUMN old;' }), [])
})

test('unchanged migrations from main are not re-checked, but an edited one is', () => {
  assert.deepEqual(check(), [], 'an unmarked historical backfill already on main stays as it is')
  const actual = new URL('../drizzle/', import.meta.url)
  const history = ['20261122191000_coding_review_sessions_name.sql', '20261121205729_issue_number_column.sql']
    .map(file => ({ name: file, content: readFileSync(new URL(file, actual), 'utf8') }))
  assert.deepEqual(checkReviewedDataMigrations(history, new Map(history.map(file => [file.name, blobId(file.content)]))), [])
  assert.equal(checkReviewedDataMigrations(history, new Map()).length, 2, 'the same files are flagged when they are new')
  assert.equal(checkReviewedDataMigrations([{ ...old, content: old.content + '-- edited\n' }], main).length, 1)
  assert.deepEqual(checkReviewedDataMigrations([{ name, content: data }], null), [], 'no main snapshot: the CLI decides')
})

test('blobId matches git hash-object', () => {
  const content = "-- ü\nSELECT 1;\n"
  assert.equal(blobId(content), execFileSync('git', ['hash-object', '--stdin'], { input: content, encoding: 'utf8' }).trim())
})

test('reviewedDataProblem names the file', () => assert.match(reviewedDataProblem(name, data), new RegExp(name)))

test('the CLI checks only what the branch adds against origin/main', () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewed-data-'))
  const scripts = join(root, 'scripts'), drizzle = join(root, 'drizzle')
  mkdirSync(scripts); mkdirSync(drizzle)
  for (const file of ['check-reviewed-data-migrations.mjs', 'automatic-migration-sql.mjs'])
    writeFileSync(join(scripts, file), readFileSync(new URL(file, import.meta.url)))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, stdio: 'pipe' })
  const run = (env = {}) => spawnSync(process.execPath, [join(scripts, 'check-reviewed-data-migrations.mjs')], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } })
  writeFileSync(join(drizzle, old.name), old.content)
  git('init', '-qb', 'main'); git('add', '.'); git('commit', '-qm', 'history with an unmarked backfill')
  // No origin/main and no origin to fetch: CI fails closed, a local run only warns.
  assert.equal(run({ CI: 'true' }).status, 1)
  assert.equal(run({ CI: '' }).status, 0)
  git('update-ref', 'refs/remotes/origin/main', 'HEAD'); git('checkout', '-qb', 'feature')
  assert.equal(run().status, 0, run().stderr)
  writeFileSync(join(drizzle, name), data)
  const rejected = run()
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, new RegExp(`${name}.*reviewed-data`))
  writeFileSync(join(drizzle, name), marked('-- migrate: reviewed-data #3300 backfill sample.flag'))
  assert.equal(run().status, 0, run().stderr)
  writeFileSync(join(drizzle, name), marked('-- migrate: reviewed-data backfill'))
  assert.match(run().stderr, /标记格式不对/)
})

test('the check stays outside the migration execution identity', async () => {
  // check-migrations.mjs, migrate.mjs and migration-steps.mjs are hashed into every release's
  // execution identity; importing this check from them would stop the deploy pipeline with
  // migration_execution_changed.
  const directory = fileURLToPath(new URL('..', import.meta.url))
  const files = execFileSync('git', ['ls-files'], { cwd: directory, encoding: 'utf8' }).split('\n').filter(Boolean)
  for (const file of ['scripts/check-reviewed-data-migrations.mjs', 'scripts/automatic-migration-sql.mjs'])
    if (!files.includes(file)) files.push(file)
  const execution = await buildMigrationExecution({ directory, files })
  assert.ok(execution.files.includes('scripts/check-migrations.mjs'))
  assert.ok(!execution.files.includes('scripts/check-reviewed-data-migrations.mjs'))
  assert.ok(!execution.files.includes('scripts/automatic-migration-sql.mjs'))
})
