import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOOTSTRAP, BROWSER_SUITES, REQUIRED_SUITES, SELF_MANAGED, TEMPLATE_BOUND, checkSummary, cloneDatabaseName, createClones, concurrency, inventory, launch, runScript, scriptSteps, shardScripts, suiteEnv, main, parseSummaries, parseSummary, readTree, testSteps, validateTarget } from './run-db-tests.mjs'
import { isE2eTarget } from '../tests/helpers/e2e-target.mjs'

const target = 'postgresql://e2e:local@127.0.0.1:5432/mikka_e2e'
const env = { CI: 'true', GITHUB_ACTIONS: 'true', E2E_DATABASE_URL: target, MIKKA_DATABASE_URL: target, DATABASE_URL: target }
// These tiny inventories model one file. Pick a standalone script so a group
// of required files sharing a package command cannot leak into the fixture.
const sample = REQUIRED_SUITES.find(candidate => REQUIRED_SUITES.filter(entry => entry.script === candidate.script).length === 1)
assert.ok(sample, 'fixture uses one independently enrolled script')
const files = { [sample.marker]: '', [sample.file]: "import { Pool } from 'pg'" }
const scripts = { [sample.script]: `node --test ${sample.file}` }

const noClone = async () => { throw new Error('no clone expected') }
const cloneAll = async (_template, names, ready) => { for (const name of names) ready(name) }
function runnerFixture(t, names = ['a', 'b', 'c']) {
  const root = mkdtempSync(join(tmpdir(), 'mikka-db-runner-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'tests'))
  const commands = Object.fromEntries(names.map(name => {
    const file = `tests/${name}.db.test.mjs`
    writeFileSync(join(root, file), '')
    return [`test:${name}-db`, `node --test ${file}`]
  }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: commands }))
  return { root, scripts: Object.keys(commands) }
}

test('verbose PostgreSQL commands flush every test record before exiting', async t => {
  const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'))
  for (const script of ['test:enterprise-db', 'test:pat-api-db']) {
    assert.ok(!scripts[script].split(/\s+/).includes('--test-force-exit'), `${script}: forced exit can discard piped reports`)
  }
  const command = scripts['test:enterprise-db']
  const tokens = command.split(/\s+/)
  assert.equal(tokens.shift(), 'node')
  const flags = tokens.slice(0, tokens.indexOf('--test') + 1)
  assert.equal(flags.at(-1), '--test')
  const directory = mkdtempSync(join(tmpdir(), 'enterprise-db-report-'))
  t.after(() => rmSync(directory, { recursive:true, force:true }))
  const fixtures = Array.from({ length:5 }, (_, index) => {
    const file = join(directory, 'report-' + index + '.test.mjs')
    writeFileSync(file, [
      "import test from 'node:test'",
      "for (let i = 0; i < 8; i++) test('database response ' + i, () => console.log('x'.repeat(16384)))",
    ].join('\n'))
    return file
  })
  const childEnv = { ...process.env }
  delete childEnv.NODE_TEST_CONTEXT
  const child = spawn(process.execPath, [...flags, ...fixtures], { env:childEnv, stdio:['ignore','pipe','pipe'] })
  const chunks = [], diagnostics = []
  child.stdout.on('data', chunk => chunks.push(chunk))
  child.stderr.on('data', chunk => diagnostics.push(chunk))
  child.stdout.once('data', () => {
    child.stdout.pause()
    setTimeout(() => child.stdout.resume(), 100)
  })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  const totals = parseSummary(Buffer.concat(chunks).toString())
  assert.equal(code, 0, Buffer.concat(diagnostics).toString())
  assert.equal(checkSummary('test:enterprise-db', code, totals), null)
  assert.equal(totals.tests, fixtures.length * 8)
})

test('DB shards are deterministic, disjoint and exhaustive, with unsharded execution as default', () => {
  const scripts = ['test:g', 'test:c', 'test:f', 'test:a', 'test:d', 'test:b', 'test:e']
  assert.deepEqual(shardScripts(scripts), scripts)
  assert.deepEqual(shardScripts(scripts, '1/4'), ['test:a', 'test:e'])
  for (let count = 1; count <= scripts.length; count++) {
    const shards = Array.from({ length: count }, (_, index) => shardScripts(scripts, `${index + 1}/${count}`))
    const combined = shards.flat()
    assert.equal(new Set(combined).size, scripts.length, `no overlap for ${count} shards`)
    assert.deepEqual(combined.sort(), [...scripts].sort(), `complete inventory for ${count} shards`)
    assert.ok(shards.every(shard => shard.length > 0))
  }
  assert.deepEqual(scripts, ['test:g', 'test:c', 'test:f', 'test:a', 'test:d', 'test:b', 'test:e'])
})

test('DB shard configuration rejects malformed, unsafe, out-of-range and empty selections', () => {
  for (const shard of ['', ' ', '1', '0/4', '1/0', '5/4', '1/-1', '1.5/4', '01/4', '1/04', '1/4\n', '1/4/2', '1/9007199254740992', null]) {
    assert.throws(() => shardScripts(['test:a'], shard), /DB_TEST_SHARD/, String(shard))
  }
  assert.throws(() => shardScripts(['test:a'], '2/2'), /selects no database suites/)
})

test('runner invokes only the selected scripts, each on its own clone, and retains full inventory and required environment', async t => {
  const fixture = runnerFixture(t)
  const logs = []
  t.mock.method(console, 'log', message => logs.push(message))
  t.mock.method(process.stdout, 'write', () => true)
  const calls = [], clones = []
  const run = (command, args, options) => {
    calls.push({ command, args, options })
    return { status: 0, stdout: '# tests 1\n# pass 1\n', stderr: '' }
  }
  const clone = async (template, names, ready) => { clones.push({ template, names }); for (const name of names) ready(name) }
  const fullEnv = { ...env, FACTORY_MONITOR_TEST_URL: target, UNRELATED_URL: 'postgresql://e2e:local@127.0.0.1:5432/other_e2e', DB_TEST_EXPECTED: fixture.scripts.join(',') }
  assert.equal(await main({ root: fixture.root, env: { ...fullEnv, DB_TEST_SHARD: '1/2' }, run, clone }), 0)
  assert.deepEqual(calls.map(call => call.args), [['-s', 'test:a-db'], ['-s', 'test:c-db']])
  assert.equal(clones.length, 1)
  assert.equal(clones[0].template, target)
  assert.equal(clones[0].names.length, 2)
  assert.match(clones[0].names[0], /^mikka_[A-Za-z0-9_]+_r[a-f0-9]{12}_s00_e2e$/)
  assert.match(clones[0].names[1], /^mikka_[A-Za-z0-9_]+_r[a-f0-9]{12}_s02_e2e$/)
  assert.notEqual(clones[0].names[0], clones[0].names[1], 'each suite gets a unique per-run clone name')
  assert.ok(logs.some(line => line.startsWith('Required DB inventory: ') && line.includes('test:b-db')))
  assert.ok(logs.includes('Required DB selection: {"shard":"1/2","total":3,"scripts":["test:a-db","test:c-db"]}'))
  for (const [index, call] of calls.entries()) {
    const clone = `postgresql://e2e:local@127.0.0.1:5432/${clones[0].names[index]}`
    assert.equal(call.command, 'pnpm')
    assert.equal(call.options.cwd, fixture.root)
    assert.equal(call.options.env.REQUIRE_DB, '1')
    assert.equal(call.options.env.CONVERSATION_READS_REQUIRE_DB, '1')
    assert.equal(call.options.env.MIKKA_TEST_DB_PORT, '5432')
    for (const name of ['E2E_DATABASE_URL', 'MIKKA_DATABASE_URL', 'DATABASE_URL', 'FACTORY_MONITOR_TEST_URL']) assert.equal(call.options.env[name], clone, name)
    assert.equal(call.options.env.UNRELATED_URL, fullEnv.UNRELATED_URL)
    assert.doesNotThrow(() => validateTarget(call.options.env))
  }
  assert.ok(logs.some(line => /^::group::pnpm test:a-db \(mikka_.*_r[a-f0-9]{12}_s00_e2e, [\d.]+s\)$/.test(line)))
  assert.ok(logs.some(line => line.startsWith('Required DB timings: ')))
  calls.length = 0
  assert.equal(await main({ root: fixture.root, env: fullEnv, run, clone }), 0)
  assert.deepEqual(calls.map(call => call.args[1]).sort(), fixture.scripts)
})

test('runner keeps suites bound to the bootstrapped database on it, one at a time, after cloning the rest', async t => {
  const bound = TEMPLATE_BOUND.slice(0, 2).map(entry => entry.script.replace(/^test:/, '').replace(/-db$/, ''))
  const fixture = runnerFixture(t, ['a', 'b', ...bound])
  t.mock.method(console, 'log', () => {})
  t.mock.method(process.stdout, 'write', () => true)
  const events = []
  let running = 0, peak = 0, boundRunning = 0
  const run = async (command, args, options) => {
    const script = args[1], onTemplate = options.env.E2E_DATABASE_URL === target
    events.push(`start ${script}`)
    running++; peak = Math.max(peak, running)
    if (onTemplate) { boundRunning++; assert.equal(boundRunning, 1, 'template-bound suites never overlap') }
    await new Promise(resolve => setTimeout(resolve, 20))
    if (onTemplate) boundRunning--
    running--
    return { status: 0, stdout: '# tests 1\n# pass 1\n', stderr: '' }
  }
  const clone = async (_template, names, ready) => {
    for (const name of names) { await new Promise(resolve => setTimeout(resolve, 5)); events.push(`clone ${name}`); ready(name) }
    events.push('cloned')
  }
  assert.equal(await main({ root: fixture.root, env: { ...env, DB_TEST_CONCURRENCY: '3', DB_TEST_EXPECTED: fixture.scripts.join(',') }, run, clone }), 0)
  const firstClone = events.find(event => /^clone mikka_.*_r[a-f0-9]{12}_s00_e2e$/.test(event))
  assert.ok(firstClone && events.indexOf('start test:a-db') > events.indexOf(firstClone), 'a suite starts once its own clone exists')
  for (const script of TEMPLATE_BOUND.slice(0, 2).map(entry => entry.script)) assert.ok(events.indexOf(`start ${script}`) > events.indexOf('cloned'), 'nothing connects to the template until every clone is taken')
  assert.deepEqual(events.filter(event => event.startsWith('start ')).map(event => event.slice(6)).sort(), fixture.scripts)
  assert.equal(peak, 3)
  for (const script of TEMPLATE_BOUND.slice(0, 2).map(entry => entry.script)) assert.ok(fixture.scripts.includes(script))
})

test('runner bounds concurrency and still reports every suite when one fails', async t => {
  const fixture = runnerFixture(t, ['a', 'b', 'c', 'd', 'e'])
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', message => errors.push(message))
  t.mock.method(process.stdout, 'write', () => true)
  t.mock.method(process.stderr, 'write', () => true)
  let running = 0, peak = 0
  const ran = []
  const run = async (command, args) => {
    running++; peak = Math.max(peak, running)
    await new Promise(resolve => setTimeout(resolve, 10))
    running--; ran.push(args[1])
    return args[1] === 'test:b-db' ? { status: 1, stdout: '# tests 1\n# fail 1\n', stderr: '' } : { status: 0, stdout: '# tests 1\n# pass 1\n', stderr: '' }
  }
  assert.equal(await main({ root: fixture.root, env: { ...env, DB_TEST_CONCURRENCY: '2' }, run, clone: cloneAll }), 1)
  assert.equal(peak, 2)
  assert.deepEqual(ran.sort(), fixture.scripts)
  assert.ok(errors.some(error => /test:b-db exited with 1/.test(error)))
  for (const value of ['0', '-1', '1.5', 'x', '100']) {
    assert.throws(() => concurrency(value), /DB_TEST_CONCURRENCY/)
    let called = false
    assert.equal(await main({ root: fixture.root, env: { ...env, DB_TEST_CONCURRENCY: value }, run() { called = true }, clone: noClone }), 1)
    assert.equal(called, false)
  }
  assert.equal(concurrency(undefined, 4), 4)
  assert.equal(concurrency('1'), 1)
})

test('a suite whose clone failed or is missing never runs, and the gate fails', async t => {
  const fixture = runnerFixture(t)
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', message => errors.push(message))
  let called = false
  assert.equal(await main({ root: fixture.root, env, run() { called = true }, clone: async () => { throw new Error('source database "mikka_e2e" is being accessed by other users') } }), 1)
  assert.equal(called, false)
  assert.ok(errors.some(error => /being accessed by other users/.test(error)))
  const ran = []
  t.mock.method(process.stdout, 'write', () => true)
  const partial = async (_template, names, ready) => { ready(names[0]) }
  assert.equal(await main({ root: fixture.root, env, run(command, args) { ran.push(args[1]); return { status: 0, stdout: '# tests 1\n# pass 1\n', stderr: '' } }, clone: partial }), 1)
  assert.deepEqual(ran, ['test:a-db'])
  assert.ok(errors.some(error => /test:b-db: clone mikka_.*_r[a-f0-9]{12}_s01_e2e was not created/.test(error)))
})

test('clone names stay loopback *_e2e databases within the identifier limit', () => {
  for (const script of ['test:a', 'test:personal-mailbox-default-off-db', `test:${'x'.repeat(120)}`, 'test:weird/$name']) {
    const name = cloneDatabaseName(target, 7, script)
    assert.ok(Buffer.byteLength(name) <= 63, name)
    assert.match(name, /^mikka_[A-Za-z0-9_]+_r[a-f0-9]{12}_s07_e2e$/)
    assert.ok(isE2eTarget(`postgresql://e2e:local@127.0.0.1:5432/${name}`))
  }
  assert.equal(suiteEnv(env, undefined).E2E_DATABASE_URL, target)
  assert.throws(() => suiteEnv(env, 'production'), /_e2e/)
})


class FakeCloneClient {
  static databases = new Map()
  static statements = []
  constructor({ connectionString }) { this.database = new URL(connectionString).pathname.slice(1) }
  async connect() {}
  async end() {}
  async query(sql, values = []) {
    FakeCloneClient.statements.push({ database: this.database, sql })
    if (sql.startsWith('CREATE DATABASE ')) {
      const match = sql.match(/^CREATE DATABASE "([^"]+)" TEMPLATE "?([^"]+)"?$/)
      assert.ok(match, sql)
      if (FakeCloneClient.databases.has(match[1])) throw new Error(`database already exists: ${match[1]}`)
      FakeCloneClient.databases.set(match[1], { template: match[2], ownership: null })
      return { rows: [], rowCount: null }
    }
    if (sql.startsWith('COMMENT ON DATABASE ')) {
      const match = sql.match(/^COMMENT ON DATABASE "([^"]+)" IS '([^']+)'$/)
      assert.ok(match, sql)
      const database = FakeCloneClient.databases.get(match[1])
      assert.ok(database)
      database.ownership = match[2]
      return { rows: [], rowCount: null }
    }
    if (sql.includes('shobj_description')) {
      const database = FakeCloneClient.databases.get(String(values[0]))
      return { rows: [{ ownership: database?.ownership ?? null }], rowCount: database ? 1 : 0 }
    }
    if (sql.startsWith('DROP DATABASE ')) {
      const name = sql.match(/^DROP DATABASE "([^"]+)" WITH \(FORCE\)$/)?.[1]
      assert.ok(name, sql)
      if (!FakeCloneClient.databases.has(name)) throw new Error(`missing database: ${name}`)
      FakeCloneClient.databases.delete(name)
      return { rows: [], rowCount: null }
    }
    throw new Error(`unexpected fake SQL: ${sql}`)
  }
}

function resetFakeCloneClient() {
  FakeCloneClient.databases = new Map([['mikka_e2e', { template: null, ownership: null }]])
  FakeCloneClient.statements = []
}

test('clone runner uses unique per-run names, never pre-drops, and cleans only matching marked databases', async () => {
  resetFakeCloneClient()
  FakeCloneClient.databases.set('mikka_runner_e2e', { template: null, ownership: 'pre-existing' })
  const runId = 'abcdef123456'
  const names = ['test:a-db', 'test:b-db'].map((script, index) => cloneDatabaseName(target, index, script, runId))
  const ready = []
  const receipt = await createClones(target, names, name => ready.push(name), { ClientClass: FakeCloneClient, runId })
  assert.deepEqual(ready, names)
  assert.equal(FakeCloneClient.databases.has('mikka_runner_e2e'), true)
  assert.equal(FakeCloneClient.statements.some(({ sql }) => sql.startsWith('DROP DATABASE ')), false)
  const control = [...FakeCloneClient.databases.keys()].find(name => name.includes('_runner_abcdef123456'))
  assert.ok(control)
  assert.ok(FakeCloneClient.databases.get(control).ownership.startsWith('mikka-test-run:'))
  const mismatch = names[1]
  FakeCloneClient.databases.get(mismatch).ownership = 'other-run'
  await assert.rejects(receipt.cleanup(), /per-run database clones could not be safely cleaned up/)
  assert.equal(FakeCloneClient.databases.has(names[0]), false)
  assert.equal(FakeCloneClient.databases.has(names[1]), true)
  assert.equal(FakeCloneClient.databases.has(control), false, 'the independently marked control database is safely cleaned')
})

test('clone runner refuses every destructive cleanup when the control provenance marker mismatches', async () => {
  resetFakeCloneClient()
  const runId = 'a1b2c3d4e5f6'
  const names = ['test:a-db'].map((script, index) => cloneDatabaseName(target, index, script, runId))
  const receipt = await createClones(target, names, () => {}, { ClientClass: FakeCloneClient, runId })
  const control = [...FakeCloneClient.databases.keys()].find(name => name.includes('_runner_a1b2c3d4e5f6'))
  assert.ok(control)
  FakeCloneClient.databases.get(control).ownership = 'other-run'
  await assert.rejects(receipt.cleanup(), /per-run database clones could not be safely cleaned up/)
  assert.equal(FakeCloneClient.databases.has(names[0]), true)
  assert.equal(FakeCloneClient.databases.has(control), true)
  assert.equal(FakeCloneClient.statements.some(({ sql }) => sql.startsWith('DROP DATABASE ')), false)
})

test('clone runner cleans every clone and its control database when run markers match', async () => {
  resetFakeCloneClient()
  const runId = 'fedcba654321'
  const names = ['test:a-db', 'test:b-db'].map((script, index) => cloneDatabaseName(target, index, script, runId))
  const receipt = await createClones(target, names, () => {}, { ClientClass: FakeCloneClient, runId })
  const control = [...FakeCloneClient.databases.keys()].find(name => name.includes('_runner_fedcba654321'))
  assert.ok(control)
  await receipt.cleanup()
  assert.equal(FakeCloneClient.databases.has('mikka_e2e'), true)
  assert.equal(FakeCloneClient.databases.has(control), false)
  for (const name of names) assert.equal(FakeCloneClient.databases.has(name), false)
  assert.ok(FakeCloneClient.statements.every(({ sql }) => !sql.startsWith('DROP DATABASE IF EXISTS')))
})

test('the default runner buffers a suite\'s output and reports its exit status', async () => {
  const result = await runScript(process.execPath, ['-e', "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"], { cwd: '.', env: process.env })
  assert.deepEqual(result, { status: 3, stdout: 'out', stderr: 'err' })
  const missing = await runScript('/nonexistent/command', [], { cwd: '.', env: process.env })
  assert.equal(missing.status, null)
})

test('the CLI streams bounded attributed progress before a suite exits and retains its complete failure', { timeout: 15_000 }, async t => {
  const fixture = runnerFixture(t, ['progress'])
  const preload = join(fixture.root, 'mock-postgres.mjs')
  writeFileSync(preload, `import { mock } from 'node:test';
    class Client { async connect() {} async query() {} async end() {} }
    mock.module(${JSON.stringify(import.meta.resolve('pg'))}, { defaultExport: { Client } });`)
  const release = join(fixture.root, 'release')
  const finished = join(fixture.root, 'finished')
  const stdout = 'SUITE-LIVE-STDOUT\n::error::fixture annotation\n:::error :::injected\n##[error]fixture legacy annotation\n'
    + '\u001b[2K\r::warning::fixture carriage return\n' + 'x'.repeat(1024) + '\n# tests 1\n# pass 0\n# fail 1\n'
  const stderr = 'SUITE-LIVE-STDERR\n'
  const stdoutTail = 'FINAL-FAILURE-STDOUT'
  const stderrTail = 'FINAL-FAILURE-STDERR'
  writeFileSync(join(fixture.root, 'pnpm'), `#!/usr/bin/env node
    const { existsSync, watch, writeFileSync } = require('node:fs');
    let released = false;
    const watcher = watch(${JSON.stringify(fixture.root)}, () => {
      if (released || !existsSync(${JSON.stringify(release)})) return;
      released = true;
      watcher.close();
      clearTimeout(deadline);
      writeFileSync(${JSON.stringify(finished)}, 'released');
      process.stdout.write(${JSON.stringify(stdoutTail)});
      process.stderr.write(${JSON.stringify(stderrTail)});
      process.exitCode = 7;
    });
    const deadline = setTimeout(() => {
      watcher.close();
      process.stderr.write('fixture progress handshake timed out\\n');
      process.exitCode = 91;
    }, 5000);
    process.stdout.write(${JSON.stringify(stdout)});
    process.stderr.write(${JSON.stringify(stderr)});`, { mode: 0o755 })
  const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--import', preload,
    fileURLToPath(new URL('./run-db-tests.mjs', import.meta.url))], {
    cwd: fixture.root, env: { ...process.env, ...env, PATH: `${fixture.root}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => { if (child.exitCode === null) child.kill() })
  const output = [], errors = []
  let released = false, finishedBeforeRelease = false, exitedBeforeRelease = false
  child.stdout.on('data', chunk => {
    output.push(chunk)
    const current = Buffer.concat(output).toString('utf8')
    if (released || !current.includes('[db-runner test:progress-db stdout] SUITE-LIVE-STDOUT\n')
      || !current.includes('[db-runner test:progress-db stderr] SUITE-LIVE-STDERR\n')) return
    finishedBeforeRelease = existsSync(finished)
    exitedBeforeRelease = child.exitCode !== null
    released = true
    writeFileSync(release, 'continue')
  })
  child.stderr.on('data', chunk => errors.push(chunk))
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  const actualOut = Buffer.concat(output).toString('utf8')
  const actualErr = Buffer.concat(errors).toString('utf8')
  assert.equal(released, true, 'both progress streams reach the caller before the child can finish')
  assert.equal(finishedBeforeRelease, false)
  assert.equal(exitedBeforeRelease, false)
  assert.equal(readFileSync(finished, 'utf8'), 'released')
  assert.equal(status, 1, 'the CLI retains its failing gate status')
  assert.ok(actualOut.includes(stdout + stdoutTail), 'final grouped stdout remains complete')
  assert.ok(actualErr.includes(stderr + stderrTail), 'final grouped stderr remains complete')
  assert.match(actualErr, /::error::test:progress-db exited with 7/)
  assert.deepEqual(parseSummary(actualOut + '\n' + actualErr), { tests: 1, pass: 0, fail: 1 }, 'progress summaries are not counted twice')
  const progress = actualOut.split('\n').filter(line => line.startsWith('[db-runner test:progress-db '))
  for (const line of progress) {
    const match = line.match(/^\[db-runner test:progress-db (stdout|stderr|lifecycle)\] (.*)$/)
    assert.ok(match, line)
    assert.ok(line.length <= 512, 'each live line including its prefix is bounded')
    assert.ok(!line.includes('::') && !line.includes('##['), 'progress never emits Actions command syntax')
    assert.doesNotMatch(line, /\p{Cc}/u, 'control characters cannot erase the prefix')
  }
  assert.ok(progress.includes(`[db-runner test:progress-db stdout] ${stdoutTail}`), 'unterminated stdout line keeps its prefix')
  assert.ok(progress.includes(`[db-runner test:progress-db stderr] ${stderrTail}`), 'unterminated stderr line keeps its prefix')
  const lifecycle = progress.filter(line => line.startsWith('[db-runner test:progress-db lifecycle] '))
  assert.deepEqual(lifecycle, [
    '[db-runner test:progress-db lifecycle] start',
    '[db-runner test:progress-db lifecycle] exit code=7 signal=none',
    '[db-runner test:progress-db lifecycle] close code=7 signal=none',
  ])
})

test('the CLI drains large failed-suite diagnostics before exiting with the failure status', t => {
  const fixture = runnerFixture(t, ['verbose'])
  const preload = join(fixture.root, 'mock-postgres.mjs')
  writeFileSync(preload, `import { mock } from 'node:test';
    class Client { async connect() {} async query() {} async end() {} }
    mock.module(${JSON.stringify(import.meta.resolve('pg'))}, { defaultExport: { Client } });`)
  const stdout = 'SUITE-STDOUT-START\n' + 'x'.repeat(1024 * 1024) + '\nSUITE-STDOUT-END\n# tests 1\n# pass 0\n# fail 1\n'
  const stderr = 'SUITE-STDERR-START\n' + 'y'.repeat(1024 * 1024) + '\nSUITE-STDERR-END\n'
  writeFileSync(join(fixture.root, 'pnpm'), `#!/usr/bin/env node
    process.stdout.write(${JSON.stringify(stdout)});
    process.stderr.write(${JSON.stringify(stderr)});
    process.exitCode = 1;`, { mode: 0o755 })
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--import', preload,
    fileURLToPath(new URL('./run-db-tests.mjs', import.meta.url))], {
    cwd: fixture.root, env: { ...process.env, ...env, PATH: `${fixture.root}:${process.env.PATH}` },
    encoding: 'utf8', maxBuffer: 4 << 20, timeout: 10_000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.ok(result.stdout.includes(stdout), 'the original failed-suite stdout is complete')
  assert.ok(result.stderr.includes(stderr), 'the original failed-suite stderr is complete')
  assert.match(result.stdout, /Required DB timings:/)
  assert.match(result.stderr, /::error::test:verbose-db exited with 1/)
})

test('runner validates all expected and discovered suites before sharding and before subprocesses', async t => {
  const fixture = runnerFixture(t)
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', message => errors.push(message))
  let called = false
  const run = () => { called = true }
  const shardEnv = { ...env, DB_TEST_SHARD: '1/2', DB_TEST_EXPECTED: fixture.scripts.join(',') }
  rmSync(join(fixture.root, 'tests/b.db.test.mjs'))
  assert.equal(await main({ root: fixture.root, env: shardEnv, run, clone: noClone }), 1)
  assert.ok(errors.some(error => /Expected DB script not enrolled: test:b-db/.test(error)))
  writeFileSync(join(fixture.root, 'tests/b.db.test.mjs'), '')
  writeFileSync(join(fixture.root, 'tests/unregistered.db.test.mjs'), '')
  assert.equal(await main({ root: fixture.root, env: shardEnv, run, clone: noClone }), 1)
  assert.ok(errors.some(error => /unregistered.db.test.mjs needs one explicit/.test(error)))
  assert.equal(called, false)
})

test('runner rejects invalid shards before execution and preserves per-shard summary failures', async t => {
  const fixture = runnerFixture(t)
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', message => errors.push(message))
  t.mock.method(process.stdout, 'write', () => true)
  t.mock.method(process.stderr, 'write', () => true)
  for (const shard of ['', '0/2', '3/2', '4/4']) {
    let called = false
    assert.equal(await main({ root: fixture.root, env: { ...env, DB_TEST_SHARD: shard }, run() { called = true }, clone: noClone }), 1)
    assert.equal(called, false)
  }
  for (const result of [
    { status: 1, stdout: '# tests 1\n# pass 1\n' },
    { status: 0, stdout: '' },
    { status: 0, stdout: '# tests 0\n# pass 0\n' },
    { status: 0, stdout: '# tests 1\n# pass 0\n# skipped 1\n' },
  ]) {
    const calls = []
    assert.equal(await main({ root: fixture.root, env: { ...env, DB_TEST_SHARD: '2/2' }, run(command, args) { calls.push(args[1]); return { ...result, stderr: '' } }, clone: cloneAll }), 1)
    assert.deepEqual(calls, ['test:b-db'])
  }
  assert.ok(errors.some(error => /test:b-db exited with 1/.test(error)))
  assert.ok(errors.some(error => /test:b-db: no node:test summary/.test(error)))
  assert.ok(errors.some(error => /test:b-db: ran no tests/.test(error)))
  assert.ok(errors.some(error => /test:b-db: 1 skipped/.test(error)))
})

test('verbose force-exit test files keep their test counts and status with separate file-backed reporters', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mikka-db-report-files-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const childEnv = { ...process.env }
  delete childEnv.NODE_TEST_CONTEXT
  const files = Array.from({ length: 3 }, (_, index) => {
    const file = `suite-${index}.test.mjs`
    writeFileSync(join(root, file), `import test from 'node:test'
      setInterval(() => {}, 60_000)
      for (let item = 0; item < 8; item++) test('result-${index}-' + item, () => {
        console.log('x'.repeat(32768))
        console.error('stderr-${index}-' + item)
      })`)
    return file
  })
  const execute = files => {
    const [bin, args] = launch('test:isolated-db', `node --test-force-exit --test-concurrency=2 --test ${files.join(' ')}`)
    return runScript(bin, args, { cwd: root, env: childEnv, script: 'test:isolated-db' })
  }
  const complete = await execute(files)
  const completeOutput = `${complete.stdout}\n${complete.stderr}`
  const report = parseSummary(completeOutput)
  assert.equal(complete.steps, files.length)
  assert.equal(checkSummary('test:isolated-db', complete.status, report, { steps: complete.steps, summaries: parseSummaries(completeOutput) }), null)
  assert.equal(report.tests, 24)
  for (let index = 0; index < files.length; index++) {
    assert.match(complete.stdout, new RegExp(`result-${index}-7`))
    assert.match(complete.stderr, new RegExp(`stderr-${index}-7`))
  }

  writeFileSync(join(root, 'missing.test.mjs'), 'process.exit(0)')
  const incomplete = await execute([files[0], 'missing.test.mjs'])
  assert.equal(incomplete.status, 1)
  assert.equal(parseSummary(incomplete.stdout).tests, 8, 'the other file reported all of its results')
  assert.match(incomplete.stderr, /missing\.test\.mjs: no node:test summary found/)
})
// The runner reads the stdout of the `node --test` orchestrator, so the preload
// must run there, not only in the per-file child processes. The orchestrator
// skips `--import` modules (merge-queue failures "no node:test summary found",
// 2026-11-26/27, test:pat-api-db and test:scope-detachment-db), and chained
// suites (test:desktop-auth, test:device-revocation-db, test:run-publication-db,
// test:run-recovery-db) ran their force-exit steps through pnpm with no preload.
// Without this file's own NODE_TEST_CONTEXT, so the spawned `node --test` runs its files.
const orchestratorEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT'))
// Each fixture file records whether its orchestrator (the parent process) holds
// a blocking stdout. Linux exposes O_NONBLOCK in /proc/<pid>/fdinfo.
const stdoutModeFixture = marks => `import { test } from 'node:test'
import { appendFileSync, readFileSync } from 'node:fs'
test('records the orchestrator stdout mode', () => {
  const flags = Number.parseInt(/^flags:\\s*(\\d+)/m.exec(readFileSync('/proc/' + process.ppid + '/fdinfo/1', 'utf8'))[1], 8)
  appendFileSync(${JSON.stringify(marks)}, process.env.STEP + ' ' + (flags & 0o4000 ? 'nonblocking' : 'blocking') + '\\n')
})
`
test('force-exit orchestrators of single and chained suites hold a blocking stdout', { skip: process.platform !== 'linux' && 'reads /proc' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'mikka-db-runner-stdout-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const marks = join(root, 'marks.txt')
  writeFileSync(join(root, 'mode.test.mjs'), stdoutModeFixture(marks))
  const commands = {
    'test:single-db': 'node --test-force-exit --test mode.test.mjs',
    'test:chain-db': 'STEP=forced NODE_ENV=test node --test-force-exit --test mode.test.mjs && STEP=plain node --test mode.test.mjs && STEP=last node --test-force-exit --test-concurrency=1 --test mode.test.mjs',
  }
  // A package script too, so a launch that falls back to pnpm still runs it.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: commands }))
  const run = script => {
    writeFileSync(marks, '')
    const [bin, args] = launch(script, commands[script])
    const result = spawnSync(bin, args, { cwd: root, encoding: 'utf8', env: orchestratorEnv() })
    assert.equal(result.status, 0, result.stderr)
    return readFileSync(marks, 'utf8').trim().split('\n')
  }
  assert.deepEqual(run('test:single-db').map(mark => mark.split(' ')[1]), ['blocking'])
  // Every step runs, in order, with its own assignments; only force-exit steps
  // get the preload, and a plain step does not inherit an earlier step's mode.
  assert.deepEqual(run('test:chain-db'), ['forced blocking', 'plain nonblocking', 'last blocking'])
})

// launch() is the only place the preload is added, and it must not run what sh
// would read differently from pnpm. Paths are injected so the quoting shows.
test('launch keeps unsafe or non-node commands on pnpm and runs plain node chains through sh', () => {
  const execPath = "/opt/node dir/it's/node", preload = '/repo dir/blocking-stdio.cjs'
  const run = command => launch('test:x-db', command, { execPath, preload })
  const forced = 'node --test-force-exit --test a.test.mjs'
  const onPnpm = {
    'double quotes': 'node --test-force-exit --test "odd name.test.mjs"',
    'single quotes': "node --test-force-exit --test 'odd name.test.mjs'",
    '||': `${forced} || node --test b.test.mjs`,
    ';': `${forced}; node --test b.test.mjs`,
    '|': `${forced} | tee out.txt`,
    'single &': `${forced} & node --test b.test.mjs`,
    '$': 'node --test-force-exit --test $FILES',
    'pnpm step': `pnpm -s build && ${forced}`,
    'tsx step': `tsx --test b.test.ts && ${forced}`,
    'no force-exit': 'node --test a.test.mjs && node --test b.test.mjs',
    'force-exit as a script argument': 'node script.mjs --test-force-exit --test a.test.mjs',
    'empty step': `${forced} && && node --test b.test.mjs`,
    'trailing &&': `${forced} &&`,
    'leading &&': `&& ${forced}`,
    'not a string': undefined,
  }
  for (const [name, command] of Object.entries(onPnpm)) assert.deepEqual(run(command), ['pnpm', ['-s', 'test:x-db']], name)

  // One plain command runs directly, with nothing for a shell to read.
  assert.deepEqual(run('node --test-force-exit --import tsx --test a.test.mjs'), [execPath, ['--require', preload, '--test-force-exit', '--import', 'tsx', '--test', 'a.test.mjs']])
  assert.deepEqual(run('node --test-force-exit=true --test a.test.mjs'), [execPath, ['--require', preload, '--test-force-exit=true', '--test', 'a.test.mjs']])
  // A chain, or a command with assignments, runs through sh: assignments kept,
  // node shell-quoted, the preload only on force-exit steps.
  const node = String.raw`'/opt/node dir/it'\''s/node'`, require = ` --require '/repo dir/blocking-stdio.cjs'`
  assert.deepEqual(run('A=1 B=two node --test-force-exit --test a.test.mjs && node --test b.test.mjs && C=3 node --test-force-exit=true --test-concurrency=1 --test c.test.mjs'),
    ['/bin/sh', ['-c', `A=1 B=two ${node}${require} --test-force-exit --test a.test.mjs && ${node} --test b.test.mjs && C=3 ${node}${require} --test-force-exit=true --test-concurrency=1 --test c.test.mjs`]])
  assert.deepEqual(run('node --test b.test.mjs && node --test-force-exit --test a.test.mjs'), ['/bin/sh', ['-c', `${node} --test b.test.mjs && ${node}${require} --test-force-exit --test a.test.mjs`]])
  assert.deepEqual(run('NODE_ENV=test node --test-force-exit --test a.test.mjs'), ['/bin/sh', ['-c', `NODE_ENV=test ${node}${require} --test-force-exit --test a.test.mjs`]])
})

test('a chain launched through sh runs when node and the preload sit under paths with spaces', t => {
  const root = mkdtempSync(join(tmpdir(), 'mikka-db-runner-quoted-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, "node bin's dir"), marks = join(root, 'marks.txt')
  mkdirSync(bin)
  symlinkSync(process.execPath, join(bin, 'node'))
  const preload = join(root, 'pre load dir', 'probe.cjs')
  mkdirSync(join(root, 'pre load dir'))
  // Records the steps whose orchestrator loaded it.
  writeFileSync(preload, `if (!process.env.NODE_TEST_CONTEXT) require('node:fs').appendFileSync(${JSON.stringify(marks)}, process.env.STEP + '\\n')\n`)
  writeFileSync(marks, '')
  writeFileSync(join(root, 'a.test.mjs'), "import { test } from 'node:test'\ntest('a', () => {})\n")
  const command = 'STEP=forced node --test-force-exit --test a.test.mjs && STEP=plain node --test a.test.mjs && STEP=last node --test-force-exit --test a.test.mjs'
  const [shell, args] = launch('test:quoted-db', command, { execPath: join(bin, 'node'), preload })
  assert.equal(shell, '/bin/sh')
  const result = spawnSync(shell, args, { cwd: root, encoding: 'utf8', env: orchestratorEnv() })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(parseSummaries(result.stdout).length, 3)
  assert.deepEqual(readFileSync(marks, 'utf8').trim().split('\n'), ['forced', 'last'])
})

// A quote, `$` or other program added to a force-exit suite later would put it
// back on pnpm without the preload, so the real inventory is checked here.
test('every required DB suite with --test-force-exit gets the blocking stdio preload', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts
  const preload = fileURLToPath(new URL('./ci/blocking-stdio.cjs', import.meta.url))
  const routes = { direct: [], sh: [] }
  for (const script of inventory(readTree(), scripts).scripts) {
    const command = scripts[script]
    if (!command.includes('--test-force-exit')) continue
    const [bin, args] = launch(script, command)
    if (bin === process.execPath) {
      assert.deepEqual(args.slice(0, 2), ['--require', preload], script)
      routes.direct.push(script)
    } else if (bin === '/bin/sh') {
      const steps = command.split('&&').filter(step => step.includes('--test-force-exit')).length
      assert.equal(args[1].split(` --require '${preload.replaceAll("'", `'\\''`)}' `).length - 1, steps, `${script}: one preload per force-exit step`)
      routes.sh.push(script)
    } else {
      assert.fail(`${script} runs --test-force-exit through ${bin} without the blocking stdio preload; keep it one node command or an && chain of node commands, with no quotes, $, pipes or other programs`)
    }
  }
  assert.ok(routes.direct.length > 0, 'single-command suites run directly')
  for (const script of ['test:desktop-auth', 'test:device-revocation-db', 'test:run-publication-db', 'test:run-recovery-db']) assert.ok(routes.sh.includes(script), `${script} runs through sh`)
})

test('force-exit keeps the summary when the last file reports a large burst into a slow reader', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mikka-db-runner-burst-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // A slow file reported first holds back a fast, noisy one: its whole report
  // reaches stdout at the end of the run, right before force-exit.
  writeFileSync(join(root, 'a.test.mjs'), "import { test } from 'node:test'\ntest('slow', () => new Promise(resolve => setTimeout(resolve, 300)))\n")
  writeFileSync(join(root, 'b.test.mjs'), "import { test } from 'node:test'\ntest('burst', () => { for (let i = 0; i < 1500; i++) console.log('x'.repeat(200)) })\n")
  // Reads 1 KiB a millisecond, so the orchestrator's stdout pipe stays full.
  const throttle = "const fs=require('fs'),b=Buffer.alloc(1024),s=new Int32Array(new SharedArrayBuffer(4));for(;;){let n;try{n=fs.readSync(0,b)}catch(e){if(e.code==='EAGAIN'){Atomics.wait(s,0,0,1);continue}throw e}if(!n)break;fs.writeSync(1,b.subarray(0,n));Atomics.wait(s,0,0,1)}"
  const [bin, args] = launch('test:burst-db', 'node --test-force-exit --test a.test.mjs b.test.mjs')
  for (let attempt = 0; attempt < 3; attempt++) {
    const suite = spawn(bin, args, { cwd: root, env: orchestratorEnv(), stdio: ['ignore', 'pipe', 'ignore'] })
    const reader = spawn(process.execPath, ['-e', throttle], { stdio: [suite.stdout, 'pipe', 'ignore'] })
    const chunks = []
    reader.stdout.on('data', chunk => chunks.push(chunk))
    const [status] = await Promise.all([new Promise(resolve => suite.on('exit', resolve)), new Promise(resolve => reader.on('close', resolve))])
    assert.equal(checkSummary('test:burst-db', status, parseSummary(Buffer.concat(chunks).toString('utf8'))), null, `attempt ${attempt + 1}`)
  }
})

test('a force-exit chain keeps every step summary when its last step reports a burst into a slow reader', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mikka-db-runner-chain-burst-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'first.test.mjs'), "import { test } from 'node:test'\ntest('first', () => {})\n")
  writeFileSync(join(root, 'a.test.mjs'), "import { test } from 'node:test'\ntest('slow', () => new Promise(resolve => setTimeout(resolve, 300)))\n")
  writeFileSync(join(root, 'b.test.mjs'), "import { test } from 'node:test'\ntest('burst', () => { for (let i = 0; i < 1500; i++) console.log('x'.repeat(200)) })\n")
  const throttle = "const fs=require('fs'),b=Buffer.alloc(1024),s=new Int32Array(new SharedArrayBuffer(4));for(;;){let n;try{n=fs.readSync(0,b)}catch(e){if(e.code==='EAGAIN'){Atomics.wait(s,0,0,1);continue}throw e}if(!n)break;fs.writeSync(1,b.subarray(0,n));Atomics.wait(s,0,0,1)}"
  const command = 'node --test first.test.mjs && node --test-force-exit --test a.test.mjs b.test.mjs'
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'test:chain-burst-db': command } }))
  const [bin, args] = launch('test:chain-burst-db', command)
  for (let attempt = 0; attempt < 3; attempt++) {
    const suite = spawn(bin, args, { cwd: root, env: orchestratorEnv(), stdio: ['ignore', 'pipe', 'ignore'] })
    const reader = spawn(process.execPath, ['-e', throttle], { stdio: [suite.stdout, 'pipe', 'ignore'] })
    const chunks = []
    reader.stdout.on('data', chunk => chunks.push(chunk))
    const [status] = await Promise.all([new Promise(resolve => suite.on('exit', resolve)), new Promise(resolve => reader.on('close', resolve))])
    const output = Buffer.concat(chunks).toString('utf8')
    assert.equal(checkSummary('test:chain-burst-db', status, parseSummary(output), { steps: testSteps(command).length, summaries: parseSummaries(output) }), null, `attempt ${attempt + 1}`)
  }
})

test('a chain step that loses its summary fails instead of dropping out of the totals', async t => {
  const command = 'node --test a.test.mjs && NODE_ENV=test node --test-force-exit --test b.test.mjs c.test.mjs && node scripts/report.mjs'
  assert.deepEqual(testSteps(command), ['node --test a.test.mjs', 'NODE_ENV=test node --test-force-exit --test b.test.mjs c.test.mjs'])
  assert.deepEqual(testSteps('node --test-force-exit --test a.test.mjs'), ['node --test-force-exit --test a.test.mjs'])
  assert.deepEqual(testSteps('pnpm -s test:x && tsx scripts/a.ts'), [])
  // Only node's own --test counts: not a script argument, and a quoted option value stays one word.
  assert.deepEqual(testSteps('node scripts/run.mjs --test && node --import tsx --test a.test.ts'), ['node --import tsx --test a.test.ts'])
  assert.deepEqual(testSteps('X=1 node --test-reporter-destination="${DIR:?dir required}/out.xml" --import tsx --test a.test.ts').length, 1)
  assert.deepEqual(testSteps('node --test-force-exit=true --test a.test.mjs'), ['node --test-force-exit=true --test a.test.mjs'])
  assert.deepEqual(testSteps('node --experimental-test-isolation none --test a.test.mjs').length, 1, 'an option value is not the script')
  const first = 'ℹ tests 3\nℹ pass 3\nℹ fail 0\n'
  const truncated = `${first}▶ second step\n  ✔ one (1ms)\n`
  // The totals alone still look like a passing suite.
  assert.equal(checkSummary('test:chain-db', 0, parseSummary(truncated)), null)
  assert.match(checkSummary('test:chain-db', 0, parseSummary(truncated), { steps: 2, summaries: parseSummaries(truncated) }), /1 node:test summaries for 2 node --test steps/)
  assert.deepEqual(parseSummaries(`${first}ℹ tests 2\nℹ pass 2\n`), [{ tests: 3, pass: 3, fail: 0 }, { tests: 2, pass: 2 }])
  assert.equal(checkSummary('test:chain-db', 0, parseSummary(`${first}ℹ tests 2\nℹ pass 2\n`), { steps: 2, summaries: parseSummaries(`${first}ℹ tests 2\nℹ pass 2\n`) }), null)
  // A summary cut after its first line, and a step that ran nothing, fail per step.
  const cut = 'ℹ tests 3\nℹ pass 3\nℹ tests 2\nℹ pass 1\nℹ tests 1\nℹ pass 2\n'
  assert.match(checkSummary('s', 0, parseSummary(cut), { steps: 3, summaries: parseSummaries(cut) }), /step 2 passed count/)
  const empty = 'ℹ tests 3\nℹ pass 3\nℹ tests 0\nℹ pass 0\n'
  assert.match(checkSummary('s', 0, parseSummary(empty), { steps: 2, summaries: parseSummaries(empty) }), /step 2 ran no tests/)

  // main() applies it to the package script's steps.
  const fixture = runnerFixture(t, ['a'])
  writeFileSync(join(fixture.root, 'package.json'), JSON.stringify({ scripts: { 'test:a-db': 'node --test tests/a.db.test.mjs && node --test-force-exit --test tests/a.db.test.mjs' } }))
  const errors = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', message => errors.push(message))
  t.mock.method(process.stdout, 'write', () => true)
  t.mock.method(process.stderr, 'write', () => true)
  assert.equal(await main({ root: fixture.root, env, run: () => ({ status: 0, stdout: truncated, stderr: '' }), clone: cloneAll }), 1)
  assert.ok(errors.some(error => /test:a-db: 1 node:test summaries for 2 node --test steps/.test(error)), errors.join('\n'))
  assert.equal(await main({ root: fixture.root, env, run: () => ({ status: 0, stdout: `${first}ℹ tests 2\nℹ pass 2\n`, stderr: '' }), clone: cloneAll }), 0)
})

test('parses TAP/spec and rejects missing, zero, skipped, todo, cancelled or failed executions', () => {
  assert.deepEqual(parseSummary('# tests 4\n# pass 4\n# fail 0\n# skipped 0\n'), { tests: 4, pass: 4, fail: 0, skipped: 0 })
  assert.deepEqual(parseSummary('ℹ tests 2\nℹ pass 1\nℹ skipped 1\n'), { tests: 2, pass: 1, skipped: 1 })
  assert.equal(checkSummary('s', 0, { tests: 3, pass: 3 }), null)
  for (const key of ['skipped', 'todo', 'fail', 'cancelled']) assert.match(checkSummary('s', 0, { tests: 3, pass: 2, [key]: 1 }), new RegExp(key))
  assert.match(checkSummary('s', 0, {}), /no node:test summary/)
  assert.match(checkSummary('s', 0, { tests: 0, pass: 0 }), /ran no tests/)
  assert.match(checkSummary('s', 0, { tests: 3, pass: 2 }), /count/)
  assert.match(checkSummary('s', 1, { tests: 3, pass: 3 }), /exited/)
  assert.match(checkSummary('s', null, { tests: 3, pass: 3 }), /exited/)
})
test('only matching ephemeral Actions URLs are permitted; missing DB fails before subprocess', async () => {
  assert.doesNotThrow(() => validateTarget(env))
  // CI is no longer required; any loopback *_e2e database on any port is allowed.
  assert.doesNotThrow(() => validateTarget({ ...env, CI: '', GITHUB_ACTIONS: '' }))
  const local = 'postgresql://e2e:local@127.0.0.1:55594/fac_overnight_e2e'
  assert.doesNotThrow(() => validateTarget({ E2E_DATABASE_URL: local, MIKKA_DATABASE_URL: local, DATABASE_URL: local }))
  for (const changes of [{ E2E_DATABASE_URL: '' }, { E2E_DATABASE_URL: target.replace('mikka_e2e', 'mikka') }, { E2E_DATABASE_URL: target.replace('127.0.0.1', 'db.internal') }, { E2E_DATABASE_URL: 'postgres://business/db' }, { DATABASE_URL: 'postgres://business/db' }, { ORVILO_DATABASE_URL: 'postgres://business/db' }, { E2E_DATABASE_URL: target + '?options=x' }]) assert.throws(() => validateTarget({ ...env, ...changes }))
  let called = false
  assert.equal(await main({ env: {}, run() { called = true }, clone: noClone }), 1)
  assert.equal(called, false)
})
test('feature inventory fails on deleted suite, removed script or zero enrollment', () => {
  assert.deepEqual(inventory(files, scripts).scripts, [sample.script])
  assert.throws(() => inventory({ [sample.marker]: '' }, scripts), /Expected DB suite missing/)
  assert.throws(() => inventory(files, {}), /Required script/)
  assert.throws(() => inventory(files, { [sample.script]: 'node -e 0' }), /no longer runs/)
  assert.throws(() => inventory({}, {}), /No database suites/)
  assert.throws(() => inventory(files, scripts, ['test:active-agents']), /Expected DB suite missing/)
})
test('discovers every present pg/DB suite and rejects unregistered or ambiguous files', () => {
  const extra = 'scripts/suggestions.db.test.ts'
  const tree = { ...files, [extra]: '', 'lib/another.test.ts': "const pg = await import('pg')" }
  assert.throws(() => inventory(tree, scripts), /needs one explicit/)
  const full = { ...scripts, 'test:suggestions-db': `node --test ${extra}`, 'test:another-db': 'node --test lib/another.test.ts' }
  assert.deepEqual(inventory(tree, full).scripts, ['test:another-db', sample.script, 'test:suggestions-db'].sort())
  assert.deepEqual(inventory(tree, full, ['test:another-db', sample.script, 'test:suggestions-db']).scripts, ['test:another-db', sample.script, 'test:suggestions-db'].sort(), 'pinned discovered suites are validated after enrollment')
  assert.throws(() => inventory(tree, full, ['test:not-present']), /Expected DB script not enrolled/)
  assert.throws(() => inventory(tree, { ...full, 'test:duplicate': `node --test ${extra}` }), /found 2/)
})
test('type-only pg imports do not enroll source-only tests as database suites', () => {
  const tree = { ...files,
    'lib/pure.test.ts': "import type { Pool, PoolClient } from 'pg'\nconst fakePool = {}",
    'lib/multiline-pure.test.ts': 'import type {\n PoolClient,\n} from "pg";\nconst fakeClient = {}',
  }
  assert.deepEqual(inventory(tree, scripts).scripts, [sample.script])
  assert.deepEqual(inventory(tree, scripts).files, [sample.file])
  assert.throws(() => inventory({ ...tree, 'lib/runtime.test.ts': "import { Pool } from 'pg'" }, scripts), /needs one explicit/)
})
test('self-managed suites are excluded only with a reason and a live dedicated runner', () => {
  const own = { file: 'lib/own-db.test.ts', runner: 'scripts/test-own-db.mjs', reason: 'starts its own Postgres' }
  const tree = { ...files, [own.file]: "import { Pool } from 'pg'", [own.runner]: `spawn('node', ['--test', '${own.file}'])` }
  assert.throws(() => inventory(tree, scripts), /needs one explicit/, 'without the exclusion it must be enrolled')
  const plan = inventory(tree, scripts, [], REQUIRED_SUITES, [own])
  assert.deepEqual(plan.scripts, [sample.script])
  assert.deepEqual(plan.selfManaged, [own.file])
  assert.throws(() => inventory({ ...tree, [own.runner]: '' }, scripts, [], REQUIRED_SUITES, [own]), /no longer runs/)
  assert.throws(() => inventory(tree, scripts, [], REQUIRED_SUITES, [{ ...own, runner: 'scripts/gone.mjs' }]), /missing/)
  assert.throws(() => inventory(tree, scripts, [], REQUIRED_SUITES, [{ ...own, reason: '' }]), /needs a reason/)
  assert.throws(() => inventory({ ...tree, [own.runner]: sample.file }, scripts, [], REQUIRED_SUITES, [{ ...own, file: sample.file }]), /both required and self-managed/)
  for (const entry of SELF_MANAGED) assert.ok(entry.reason && entry.runner)
})
test('dedicated browser inventory requires its spec, config and script, without exempting adjacent DB tests', () => {
  const suite = BROWSER_SUITES[0]
  const tree = { ...files, ...Object.fromEntries(BROWSER_SUITES.flatMap(suite => [[suite.file, "import { Pool } from 'pg'"], [suite.config, 'export default {}']])) }
  const commands = { ...scripts, [suite.script]: `playwright test --config=${suite.config}` }
  const plan = inventory(tree, commands)
  assert.deepEqual(plan.browser, BROWSER_SUITES.map(suite => suite.file).sort())
  assert.deepEqual(plan.scripts, [sample.script], 'Playwright is not sent to the node:test summary checker')
  assert.throws(() => inventory(tree, scripts), /Browser script .* missing/)
  assert.throws(() => inventory(tree, { ...commands, [suite.script]: 'playwright test' }), /no longer runs/)
  const noSpec = { ...tree }; delete noSpec[suite.file]
  assert.throws(() => inventory(noSpec, commands), /Expected browser suite missing/)
  const noConfig = { ...tree }; delete noConfig[suite.config]
  assert.throws(() => inventory(noConfig, commands), /config .* missing/)
  assert.throws(() => inventory({ ...tree, 'tests/mvp/new.db.test.ts': "import { Pool } from 'pg'" }, commands), /needs one explicit package test script/)
  assert.throws(() => inventory({ ...tree, 'tests/mvp/new.spec.ts': "import { Pool } from 'pg'" }, commands), /needs one explicit package test script/)
})
test('real-driver offline exclusions require the actual source guard and the explicit pure script',()=>{
  const entry={file:'scripts/offline.test.mjs',script:'test:offline',guard:'scripts/guard.mjs',reason:'reviewed zero-transport test'}
  const tree={...files,[entry.file]:"import './guard.mjs'; import pg from 'pg'",[entry.guard]:'deny native transport'}
  const commands={...scripts,[entry.script]:`node --import ./${entry.guard} --test ${entry.file}`}
  assert.deepEqual(inventory(tree,commands,[],REQUIRED_SUITES,[],[entry]).offlineGuarded,[entry.file])
  assert.throws(()=>inventory({...tree,[entry.file]:"import pg from 'pg'"},commands,[],REQUIRED_SUITES,[],[entry]),/source guard/)
  assert.throws(()=>inventory(tree,{...commands,[entry.script]:`node --test ${entry.file}`},[],REQUIRED_SUITES,[],[entry]),/source guard/)
  assert.throws(()=>inventory(tree,commands,[],REQUIRED_SUITES,[],[{...entry,reason:''}]),/source guard/)
})
test('offline guard must be on the same step that runs the guarded file (GM3)',()=>{
  const entry={file:'scripts/offline.test.mjs',script:'test:offline',guard:'scripts/guard.mjs',reason:'reviewed zero-transport test'}
  const tree={...files,[entry.file]:"import './guard.mjs'; import pg from 'pg'",[entry.guard]:'deny native transport'}
  const run=command=>inventory(tree,{...scripts,[entry.script]:command},[],REQUIRED_SUITES,[],[entry])
  assert.deepEqual(run(`node --test a.test.mjs; r1=$?; node --import ./${entry.guard} --test ${entry.file}; r2=$?; exit $((r1|r2))`).offlineGuarded,[entry.file])
  for (const sep of ['&&',';','||']) assert.throws(()=>run(`node --test ${entry.file} ${sep} node --import ./${entry.guard} --test other.test.mjs`),/source guard/)
  assert.throws(()=>run(`node --import ./${entry.guard}x --test ${entry.file}`),/source guard/)
  assert.deepEqual(scriptSteps('a && b; c || d'),['a','b','c','d'])
})
test('live database authentication schema inspection finishes before temporary-schema fixtures start', () => {
  const command = JSON.parse(readFileSync('package.json', 'utf8')).scripts['test:live-db']
  const steps = command.split(' && ')
  const groups = steps.map(step => step.split(/\s+/).filter(token => token.endsWith('.db.test.ts')))
  const files = groups.flat()
  const authentication = files.filter(file => /\bbetterAuth\s*\(/.test(readFileSync(file, 'utf8'))).sort()
  assert.deepEqual(authentication, ['lib/computer/event-session.db.test.ts', 'lib/live/ticket-session.db.test.ts'])
  assert.deepEqual([...groups[0]].sort(), authentication, 'BetterAuth introspects all schemas, including schemas concurrently dropped by other fixtures')
  assert.equal(groups.length, 2)
  assert.equal(new Set(files).size, files.length, 'each required file runs exactly once')
  assert.ok(groups[1].includes('lib/computer/event-broker.db.test.ts'))
  assert.ok(steps.every(step => step.startsWith('node ') && step.includes('--test ')))
  // Exercise the actual shell separators without starting a database. A failed
  // authentication group must remain a failed gate, never an ignored first step.
  for (const [auth, fixtures] of [[0, 0], [1, 0], [0, 1]]) {
    let stubbed = command
    for (const [index, step] of steps.entries()) stubbed = stubbed.replace(step, `sh -c 'echo group${index}; exit ${index ? fixtures : auth}'`)
    const result = spawnSync('sh', ['-c', stubbed], { encoding: 'utf8' })
    assert.equal(result.stdout, auth ? 'group0\n' : 'group0\ngroup1\n')
    assert.equal(result.status, auth || fixtures)
  }
})

test('test:personal-mailbox-core runs the runtime-off step even when the first step fails, and still fails overall',()=>{
  const command=JSON.parse(readFileSync('package.json','utf8')).scripts['test:personal-mailbox-core']
  const steps=command.split(/;\s*/)
  const nodeSteps=steps.filter(step=>/^node\s/.test(step))
  assert.equal(nodeSteps.length,2)
  assert.ok(nodeSteps[1].includes('lib/personal-mailbox-runtime-off.test.ts'))
  const run=(first,second)=>{
    let i=0
    const stubbed=steps.map(step=>/^node\s/.test(step)?(i++===0?`echo first; ${first}`:`echo second; ${second}`):step).join('; ')
    return spawnSync('sh',['-c',stubbed],{encoding:'utf8'})
  }
  for (const [first,second,code] of [['true','true',0],['false','true',1],['true','false',1],['false','false',1]]) {
    const r=run(first,second)
    assert.equal(r.stdout,'first\nsecond\n',`both steps run (${first},${second})`)
    assert.equal(r.status===0?0:1,code,`exit for (${first},${second})`)
  }
})
test('offline guard import is resolved relative to the suite file',()=>{
  const entry={file:'lib/nested/offline.test.ts',script:'test:offline',guard:'scripts/guard.mjs',reason:'reviewed zero-transport test'}
  const tree={...files,[entry.file]:"import '../../scripts/guard.mjs'\nimport pg from 'pg'",[entry.guard]:'deny native transport'}
  const commands={...scripts,[entry.script]:`node --import ./${entry.guard} --test ${entry.file}`}
  assert.deepEqual(inventory(tree,commands,[],REQUIRED_SUITES,[],[entry]).offlineGuarded,[entry.file])
  assert.throws(()=>inventory({...tree,[entry.file]:"import './guard.mjs'\nimport pg from 'pg'"},commands,[],REQUIRED_SUITES,[],[entry]),/source guard/)
})
test('this tree has explicit complete DB inventory and retains bootstrap ordering and pure gates', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')).scripts
  const tree = readTree()
  assert.ok(Object.hasOwn(tree, 'scripts/run-db-tests.test.mjs'), 'script-hosted suites are discovered too')
  const plan = inventory(tree, pkg)
  assert.ok(plan.offlineGuarded.includes('scripts/test-accounts/docker-environment.test.mjs'))
  assert.ok(!plan.offlineGuarded.includes('lib/db/egress-sample.test.ts'), 'the pure gate must not rely on an exemption absent from the trusted base policy')
  assert.ok(!plan.scripts.includes('test:lib-units'), 'real-driver queue coverage belongs to the existing mandatory PostgreSQL gate')
  assert.ok(plan.files.includes('lib/db/transport-sample.db.test.ts'))
  assert.ok(plan.scripts.includes('test:ops-db'), 'real PostgreSQL attribution and byte-count regressions remain required')
  assert.ok(!plan.scripts.includes('test:test-accounts'), 'mocked Docker adapter stays in the transport-guarded pure gate')
  assert.ok(plan.scripts.includes('test:test-accounts-db'), 'real test-account database suites remain required')
  assert.ok(plan.files.includes('tests/desktop-native-resources.db.test.mjs'))
  assert.ok(plan.files.includes('tests/test-account-pool.db.test.mjs'))
  assert.ok(plan.scripts.includes('test:groups'))
  assert.ok(plan.scripts.includes('test:workspace-migration-db'))
  assert.ok(plan.scripts.includes('test:local-repository-migration-db'))
  assert.ok(plan.scripts.includes('test:relation-cycle'))
  assert.ok(plan.scripts.includes('test:coordinator-native'))
  assert.ok(plan.files.includes('lib/coordinator/native-store.test.ts'))
  assert.ok(plan.scripts.includes('test:eve-db'))
  assert.ok(plan.scripts.includes('test:eve-graphile-db'))
  assert.ok(plan.files.includes('tests/eve-runtime-graphile-event-driven.db.test.mjs'))
  for (const file of ['approval-bridge', 'scheduled-read', 'scope', 'settlement', 'sandbox', 'evaluation-store']) assert.ok(plan.files.includes(`lib/eve/${file}.db.test.ts`))
  assert.ok(plan.selfManaged.includes('lib/auth-email.test.ts'))
  assert.ok(plan.scripts.includes('test:factory'))
  assert.ok(plan.files.includes('lib/self-improvement/wiring-postgres.test.ts'))
  const workflow = readFileSync('.github/workflows/ui-policy.yml', 'utf8')
  const taskCommands = Object.values(JSON.parse(readFileSync('scripts/ci/tasks.json'))).map(task => task.command)
  const custodyWorkflow = readFileSync('.github/workflows/e2b-byos.yml', 'utf8')
  for (const { runner, local } of SELF_MANAGED) {
    const dedicatedScript = Object.entries(pkg).find(([, command]) => command === `node ${runner}`)?.[0]
    // Decision 2026-11-01-1520: the one runner that needs a production build left CI with the
    // browser job; it must stay runnable locally through its own package script.
    if (local) { assert.equal(runner, 'scripts/test-accounts/run-http.mjs'); assert.ok(dedicatedScript, `${runner} has a package script`); continue }
    assert.ok(taskCommands.includes(`node ${runner}`) || workflow.includes(`run: node ${runner}`) || (dedicatedScript && custodyWorkflow.includes(`run: pnpm ${dedicatedScript}`)), `${runner} runs in CI`)
  }
  // Pure gates also run without a database in the fast job; their DB run is still only through pnpm test:db.
  const pureGates = ['test:groups', 'test:active-agents', 'test:group-turns', 'test:issue-search']
  for (const script of plan.scripts) {
    if (!pureGates.includes(script)) assert.ok(!new RegExp(`pnpm ${script}(?:\\s|$)`).test(workflow), `${script} runs once, through pnpm test:db`)
  }
  assert.ok(!/node --test tests\/workspace-migration\.test\.mjs/.test(workflow), 'workspace migration runs once, through pnpm test:db')
  const pinned = workflow.match(/DB_TEST_EXPECTED: ([^\n]+)/)?.[1].split(',').sort()
  assert.deepEqual(pinned, plan.scripts, 'workflow explicitly pins every suite expected on this tree')
  for (const script of pureGates.slice(1)) {
    if (pkg[script]) {
      assert.ok(taskCommands.some(command => command.includes(`pnpm ${script}`)) || workflow.includes(`pnpm ${script}`), `${script} strict pure gate retained`)
      assert.ok(pkg.check.includes(`pnpm ${script}`), `${script} pure gate in check`)
    }
  }
  assert.ok(workflow.includes(BOOTSTRAP))
  assert.ok(workflow.indexOf(BOOTSTRAP) < workflow.indexOf('- run: pnpm test:e2e:setup'))
  assert.ok(workflow.indexOf('- run: pnpm test:e2e:setup') < workflow.indexOf('run: pnpm test:db\n'))
  assert.match(workflow, /MIGRATION_BOOTSTRAP_CI: '1'/)
  assert.match(workflow, /REQUIRE_DB: '1'/)
  assert.equal(pkg['test:e2e:mvp'], 'playwright test --config=playwright.mvp.config.ts')
  assert.deepEqual(plan.browser, ['tests/mvp/coordinator-streaming.spec.ts', 'tests/mvp/core-loop.spec.ts'])
  const mvpConfig = readFileSync('playwright.mvp.config.ts', 'utf8')
  assert.match(mvpConfig, /testDir:\s*['"]\.\/tests\/mvp['"]/)
  assert.match(mvpConfig, /testMatch:\s*['"]\*\*\/\*\.spec\.ts['"]/)
  assert.ok(tree['tests/mvp/core-loop.spec.ts']?.includes('@playwright/test'), 'the real-daemon browser spec remains present')
  assert.match(workflow, /image: postgres:17/)
  for (const name of ['test:agent', 'test:suggestions', 'test:integrations', 'test:issues', 'test:db-runner']) {
    assert.ok(taskCommands.some(command => command.includes(`pnpm ${name}`)) || workflow.includes(`pnpm ${name}`), `${name} strict gate retained`)
    assert.ok(pkg.check.includes(`pnpm ${name}`), `${name} in check`)
  }
})

test('the disposable CI service budgets cluster-wide DDL locks for parallel full-schema cleanup', () => {
  const workflow = readFileSync('.github/workflows/ui-policy.yml', 'utf8')
  const job = workflow.split('\n  browser-tests-full:')[1]
  assert.ok(job, 'the required database matrix must exist')
  const service = job.split('\n    services:')[1]?.split('\n    env:')[0]
  assert.ok(service, 'capacity belongs to the disposable service, not application configuration')
  assert.match(service, /image: postgres:17/)
  assert.match(service, /POSTGRES_INITDB_ARGS: --set=max_locks_per_transaction=512/)
  assert.equal(concurrency(undefined), 4, 'retain the existing parallel DB suites')
  assert.match(job, /REQUIRE_DB: '1'/)
  assert.match(job, /run: pnpm test:db\n/)
})

test('self-improvement DB suite stays mandatory when its feature exists', () => {
  const required = [{ marker: 'lib/self-improvement/store.ts', file: 'lib/self-improvement/postgres.test.ts', script: 'test:self-improvement-db' }]
  const tree = { [required[0].marker]: '', [required[0].file]: "import { Pool } from 'pg'" }
  const scripts = { 'test:self-improvement-db': 'node --import tsx --test lib/self-improvement/postgres.test.ts' }
  assert.deepEqual(inventory(tree, scripts, [], required).scripts, ['test:self-improvement-db'])
  assert.throws(() => inventory({ [required[0].marker]: '' }, scripts, [], required), /Expected DB suite missing/)
  assert.throws(() => inventory(tree, {}, [], required), /Required script/)
})

test('isolated fixture databases reject application targets before I/O', async () => {
  const { isolatedPostgresURL } = await import('../tests/helpers/isolated-postgres.mjs')
  for (const target of ['postgresql://business.invalid/mikka_e2e', 'postgresql://localhost/mikka',
    'https://localhost/mikka_e2e', 'postgresql://localhost/mikka_e2e?options=-c%20search_path=public',
    'postgresql://localhost/mikka_e2e#fragment']) {
    await assert.rejects(isolatedPostgresURL(target), /disposable test database/)
  }
})

test('isolated fixture databases create distinct empty databases and close admin pools on success or failure', async t => {
  const { Pool } = await import('pg')
  const { isolatedPostgresURL } = await import('../tests/helpers/isolated-postgres.mjs')
  const queries = []
  let ended = 0
  t.mock.method(Pool.prototype, 'query', async sql => { queries.push(sql) })
  t.mock.method(Pool.prototype, 'end', async () => { ended++ })
  const first = new URL(await isolatedPostgresURL(target))
  const second = new URL(await isolatedPostgresURL(target))
  assert.notEqual(first.pathname, second.pathname)
  assert.match(first.pathname, /^\/mikka_fixture_[a-f0-9]{32}_e2e$/)
  assert.equal(first.origin, new URL(target).origin)
  assert.equal(first.username, new URL(target).username)
  assert.equal(first.password, new URL(target).password)
  assert.deepEqual(queries, [first, second].map(url => `CREATE DATABASE "${url.pathname.slice(1)}" TEMPLATE template0`))
  assert.equal(ended, 2)
  t.mock.method(Pool.prototype, 'query', async () => { throw new Error('no createdb permission') })
  await assert.rejects(isolatedPostgresURL(target), /no createdb permission/)
  assert.equal(ended, 3)
})

test('affected execution narrows only after complete inventory and cannot hide missing unselected suites', async t => {
  const fixture = runnerFixture(t)
  const ran = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  t.mock.method(process.stdout, 'write', () => true)
  const selected = fixture.scripts[1]
  const fullEnv = { ...env, DB_TEST_EXPECTED: fixture.scripts.join(','), DB_TEST_SELECTED: JSON.stringify([selected]), DB_TEST_SHARD: '1/1' }
  const run = (_command, args) => { ran.push(args[1]); return { status: 0, stdout: '# tests 1\n# pass 1\n', stderr: '' } }
  assert.equal(await main({ root: fixture.root, env: fullEnv, run, clone: cloneAll }), 0)
  assert.deepEqual(ran, [selected])
  rmSync(join(fixture.root,'tests/a.db.test.mjs'))
  ran.length = 0
  assert.equal(await main({ root: fixture.root, env: fullEnv, run, clone: cloneAll }), 1)
  assert.deepEqual(ran, [], 'unselected inventory corruption fails before execution')
})
