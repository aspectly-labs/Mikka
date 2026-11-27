import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import yaml from 'js-yaml'
import { select, diffRange, emit, desktopClosure, desktopEntryFiles, desktopRunPaths, desktopWorkspaceRoots, DESKTOP_VIRTUAL_INPUT, DESKTOP_PATH } from './select.mjs'
import { buildGraph, dbId, sourceId, strictCommand } from './graph.mjs'
import { selectScripts, shardScripts } from '../run-db-tests.mjs'

const change = (file, extra = {}) => ({file, status:'M', mode:'100644', oldMode:'100644', ...extra})
const plan = buildGraph()
const pick = (file, extra) => select(plan, [change(file, extra)])

test('the legacy iOS app is retired and no longer selected in public Mikka', async () => {
  const result = await pick('messages/en.json')
  assert.equal('mobile' in result, false)
})
test('non-documentation plans keep the suite that actually exercises the docs classifier', async () => {
  const planForWeb = await pick('apps/frontend/src/headless.ts')
  const owners = planForWeb.units.filter(unit =>
    plan.graph.dependencies[unit]?.some(edge => edge.target === sourceId('scripts/ci-docs-only.test.mjs')))
  assert.deepEqual(owners, ['ci-core-7'])
})

for (const [file, primary] of [
  ['lib/agent-kit/registry-compat.test.ts', 'ci-core-29'],
  ['lib/agent-kit/tool-defaults-compat.test.ts', 'ci-core-29'],
  ['lib/coordinator/issue-tools.test.ts', 'ci-core-43'],
  ['lib/search/search.test.ts', 'ci-integration-9'],
]) test(`same-environment shared regression has one selected owner: ${file}`, async () => {
  const result = await pick(file)
  const owners = result.units.filter(unit =>
    plan.graph.dependencies[unit]?.some(edge => edge.target === sourceId(file)))
  assert.deepEqual(owners, [primary])
})

test('personal mailbox shell legs keep their last test files in the selection graph', async () => {
  for (const file of ['lib/personal-mailbox-retry-context.test.ts', 'lib/personal-mailbox-runtime-off.test.ts']) {
    assert(plan.graph.dependencies['ci-core-18'].some(edge => edge.target === sourceId(file)), file)
    assert((await pick(file)).units.includes('ci-core-18'), file)
  }
})

test('approved-write policy, provider and UI regressions have one selected primary owner', async () => {
  for (const [input, proof] of [
    ['lib/operations/write-feature.ts', 'lib/operations/write-feature.test.ts'],
    ['lib/operations/policy-authorization.ts', 'lib/operations/policy-authorization.test.ts'],
    ['lib/operations/write-client.ts', 'lib/operations/write-client.test.ts'],
  ]) {
    const result = await pick(input)
    const owners = result.units.filter(unit =>
      plan.graph.dependencies[unit]?.some(edge => edge.target === sourceId(proof)))
    assert.deepEqual(owners, ['ci-core-30'], input)
    assert.equal(result.source, true, 'source and security checks remain required')
  }
})

test('web client edits select their consumers without server DB or Docker', async () => {
  // The interface itself is the official UI checkout; the page a build without it serves is the public web client.
  const result = await pick('apps/frontend/src/headless.ts')
  assert.equal(result.full, false)
  assert.equal(result.daemon, false)
  assert.deepEqual(result.db_suites, [])
  assert(result.source)
})
test('daemon is selected through its package dependency and protocol expands globally', async () => {
  const result = await pick('packages/daemon/src/adapters/codex.ts')
  assert.equal(result.full, false)
  assert.equal(result.daemon, true)
  const shared = await pick('packages/protocol/src/run.ts')
  assert(shared.full)
  assert(shared.daemon && shared.desktop)
  assert.deepEqual(shared.db_suites, plan.db.scripts)
})
test('Factory store selects marker-backed suites and real downstream imports', async () => {
  const result = await pick('lib/factory/store.ts')
  for (const suite of ['test:factory','test:factory-routing-db']) assert(result.db_suites.includes(suite), suite)
  assert(result.affected.includes(dbId('test:factory')))
  assert(result.db_suites.length < plan.db.scripts.length)
})
test('Cloudflare Eve Graphile Postgres recovery suite is inventoried and selected', async () => {
  const file = 'tests/eve-runtime-graphile-event-driven.db.test.mjs'
  assert(plan.db.scripts.includes('test:eve-graphile-db'))
  const result = await pick(file)
  assert(result.db_suites.includes('test:eve-graphile-db'))
  assert(result.affected.includes(dbId('test:eve-graphile-db')))
})

test('enrolled billing fixture edits retain their real DB consumers without unrelated lanes', async () => {
  // The seven-file local-fixtures candidate previously selected all 87 DB
  // suites solely because the four root tests had no path-area classification.
  const result = await select(plan, [
    'lib/abuse/card.db.test.ts', 'lib/abuse/card.test.ts', 'lib/abuse/model-postpay.db.test.ts',
    'tests/billing-history.db.test.ts', 'tests/credit-shares.db.test.ts',
    'tests/model-order.db.test.ts', 'tests/personal-workspace.db.test.ts',
  ].map(file => change(file)))
  assert.equal(result.full, false)
  // Keep both explicit package owners and the existing source-contract callers.
  assert.deepEqual(result.db_suites, [
    'test:abuse-db', 'test:approved-writes-db', 'test:bot-threads-db',
    'test:coordinator-task-binding-db', 'test:migration-steps-db',
    'test:onboarding-db', 'test:scope-detachment-db', 'test:workspace-admin-db',
  ])
  assert(result.source)
  for (const flag of ['daemon', 'desktop', 'analytics']) assert.equal(result[flag], false, flag)
  for (const script of ['test:release-security', 'test:credentials', 'test:test-accounts', 'test:abuse']) {
    assert(result.unit_tasks.some(task => task.command.includes(`pnpm ${script}`)), script)
  }
})
test('a DB-looking path needs both enrollment and an existing direct suite edge', async () => {
  const file = 'tests/billing-history.db.test.ts'
  const withoutEnrollment = { ...plan, db: { ...plan.db, files: plan.db.files.filter(value => value !== file) } }
  const dependencies = Object.fromEntries(Object.entries(plan.graph.dependencies).map(([id, edges]) => [
    id, id.startsWith('db-') ? edges.filter(edge => edge.target !== sourceId(file)) : edges,
  ]))
  const withoutSuiteEdge = { ...plan, graph: { ...plan.graph, dependencies } }
  for (const incomplete of [withoutEnrollment, withoutSuiteEdge]) {
    const result = await select(incomplete, [change(file)])
    assert(result.full)
    assert(result.reasons.includes('unmapped file'))
    assert.deepEqual(result.db_suites, plan.db.scripts)
  }
  assert((await pick('tests/not-enrolled.db.test.ts')).full)
})
test('enrolled root DB tests still respect full-validation reasons', async () => {
  const file = 'tests/billing-history.db.test.ts'
  for (const extra of [{ status: 'D' }, { status: 'R100' }, { mode: '100755' }, { mode: '120000' }, { oldMode: '100755' }]) {
    assert((await pick(file, extra)).full)
  }
  const unresolved = await select({ ...plan, unresolved: [...plan.unresolved, { file, spec: '<computed import>' }] }, [change(file)])
  assert(unresolved.full)
  assert(unresolved.reasons.includes('changed source has unresolved/generated imports'))
  const forced = await select(plan, [change(file)], { force: true })
  assert(forced.full)
  assert.deepEqual(forced.db_suites, plan.db.scripts)
  const mixedUnknown = await select(plan, [change(file), change('unmapped.bin')])
  assert(mixedUnknown.full)
  assert(mixedUnknown.reasons.includes('unmapped file'))
})
test('Eve model changes select native unit tests and schedule authority selects its database gate', async () => {
  const unit = await pick('lib/eve/streaming-model.ts')
  assert(unit.units.includes('ci-core-41'))
  const database = await pick('lib/eve/scheduled-read.ts')
  assert(database.db_suites.includes('test:eve-db'))
  assert(database.affected.includes(dbId('test:eve-db')))
})
for (const file of ['pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','.github/workflows/ui-policy.yml','scripts/ci/select.mjs','lib/db/schema.ts','lib/auth.ts','lib/credentials/store.ts','unmapped.bin']) test(`high risk or unmapped input expands: ${file}`, async () => {
  const r = await pick(file)
  assert(r.full)
  assert.equal(r.db_suites.length, plan.db.scripts.length)
  assert(r.daemon && r.desktop)
})
// A migration changes the schema every suite runs against, so it keeps the full
// DB inventory; it says nothing about rendering, so it must not turn on the
// macOS packaged acceptance the other global inputs do. Uses a migration that
// exists, because a name absent from the graph expands for an unrelated reason.
test('a migration keeps every DB suite without turning on the packaged desktop build', async () => {
  const migration = Object.keys(plan.graph.nodes).find(id => id.startsWith('source:drizzle/') && id.endsWith('.sql'))
  assert.ok(migration, 'the graph must map at least one migration')
  const r = await pick(migration.slice('source:'.length))
  assert(!r.full)
  assert.equal(r.db_suites.length, plan.db.scripts.length)
  assert(!r.desktop)
})
test('deletes, renames, executable modes, symlinks and empty diffs run all', async () => {
  for(const extra of [{status:'D'},{status:'R100'},{mode:'100755'},{mode:'120000'},{oldMode:'100755'}]) assert((await pick('README.md', extra)).full)
  assert((await select(plan, [])).full)
})
test('unknown graph and unresolved sources cannot skip jobs', async () => {
  const missing = await select({...plan, graph:{nodes:{},dependencies:{}}}, [change('lib/factory/store.ts')])
  assert(missing.full)
  const unresolved = await select({...plan, unresolved:[{file:'components/plugins/github-settings.tsx'}]}, [change('components/plugins/github-settings.tsx')])
  assert(unresolved.full)
})
test('docs retain the fast tier but inventory is built before that decision', async () => {
  const r = await pick('docs/dev-workflow.md')
  assert((await pick('packages/daemon/README.md')).docs_only)
  assert((await pick('.github/workflows/README.md')).docs_only)
  assert(r.docs_only)
  assert.equal(r.source, false)
  assert.equal(r.units.length, 0)
  assert.equal(r.db_suites.length, 0)
  assert(plan.db.files.length > 70)
})
test('fork PRs, main and merge queue use full immutable SHA ranges; other events full', () => {
  assert.deepEqual(diffRange({GITHUB_EVENT_NAME:'pull_request'}, {pull_request:{base:{sha:'base'},head:{sha:'fork'}}}), ['base','fork'])
  assert.deepEqual(diffRange({GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main'}, {before:'before',after:'after'}), ['before','after'])
  assert.deepEqual(diffRange({GITHUB_EVENT_NAME:'merge_group'}, {merge_group:{base_sha:'base',head_sha:'merge'}}), ['base','merge'])
  for (const name of ['schedule','workflow_dispatch','unknown']) assert.deepEqual(diffRange({GITHUB_EVENT_NAME:name}, {}), [])
})
test('selected DB suites remain a nonempty subset and dynamic shards are exhaustive', () => {
  for (const selection of ['[]','null','["unknown"]','["test:a","test:a"]']) assert.throws(()=>selectScripts(['test:a'],selection))
  const scripts = selectScripts(plan.db.scripts, JSON.stringify(plan.db.scripts.slice(0,2)))
  assert.equal(shardScripts(scripts,'1/1').length,2)
  assert.throws(()=>shardScripts(scripts,'3/3'))
})
test('shared aliases and glob imports become graph edges rather than missed test inputs', () => {
  assert(Object.values(plan.graph.dependencies).some(edges=>edges.some(e=>e.target.startsWith('source:packages/protocol/'))))
})
test('every heavy consumer uses the same trusted triage and required names remain', () => {
  for(const file of ['ui-policy','desktop','analytics-ssr']) assert(readFileSync(`.github/workflows/${file}.yml`,'utf8').includes('uses: ./.github/workflows/ci-selection.yml'))
  const bootstrap=readFileSync('scripts/ci/bootstrap.sh','utf8')
  assert(bootstrap.includes('git archive "$trusted_sha"'))
  assert(bootstrap.includes('--frozen-lockfile --ignore-scripts'))
  assert(bootstrap.includes('CI_CANDIDATE_ROOT="$candidate"'))
  const ci=readFileSync('.github/workflows/ui-policy.yml','utf8')
  assert(ci.includes('name: UI policy (strict)'))
  assert(ci.includes('name: Production build and browser interactions'))
  assert(!ci.includes('playwright install'))
})

test('the actual required gate scripts reject drafts, unselected failures and selected skips', () => {
  const workflow = yaml.load(readFileSync('.github/workflows/ui-policy.yml','utf8'))
  for (const job of ['ui-policy','browser-tests']) {
    const steps = workflow.jobs[job].steps
    const draftGate = steps.find(step => step.name === 'Draft PR is not a validated merge candidate')
    for (const draft of [true, false]) {
      assert.equal(runInNewContext(draftGate.if, { github: { event_name: 'pull_request', event: { pull_request: { draft } } } }), draft)
      if (draft) assert.equal(spawnSync('bash', ['-e', '-c', draftGate.run], { env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: '/dev/null' } }).status, 1)
    }
    const script = steps.find(step => step.name?.startsWith('Require every selected ')).run
    const declared = script.match(/for name in ([A-Z ]+); do/)
    const names = declared ? declared[1].split(/\s+/) : []
    if (job === 'ui-policy') assert.ok(names.length, 'the gate names the results it requires')
    const run = overrides => {
      const env = {
        PATH: process.env.PATH,
        GITHUB_STEP_SUMMARY: '/dev/null',
        CHANGES_RESULT: 'success',
        EXPECT_DB: 'true',
        DB_RESULT: 'success',
      }
      for (const key of names) {
        env['EXPECT_' + key] = 'true'
        env[key] = 'success'
      }
      Object.assign(env, overrides)
      try { execFileSync('bash',['-e','-c',script],{env,stdio:'ignore'});return true } catch { return false }
    }
    assert(run({}))
    assert(!run({CHANGES_RESULT:'failure'}))
    for(const result of ['skipped','failure','cancelled','timed_out','']) {
      if(job==='ui-policy') for(const key of names) assert(!run({[key]:result}))
      else assert(!run({DB_RESULT:result}))
    }
    if (job === 'ui-policy') {
      // Desktop is a selected lane again (desktop-checks calls desktop.yml); the image lane stays retired.
      assert(names.includes('DESKTOP'), 'the automatic gate requires the selected Desktop suite')
      for (const retired of ['IMAGE']) {
        assert(!new RegExp(`\\b(?:EXPECT_)?${retired}\\b`).test(script), retired)
        for (const result of ['success', 'skipped', 'failure', 'cancelled', 'timed_out', ''])
          assert(run({ ['EXPECT_' + retired]: 'true', [retired]: result }), `a retired ${retired} result does not affect the automatic gate`)
      }
      for (const key of names) {
        assert(run({['EXPECT_' + key]: 'false', [key]: 'skipped'}), key)
        for (const result of ['success', 'failure', 'cancelled']) {
          assert(!run({['EXPECT_' + key]: 'false', [key]: result}), key)
        }
      }
    }
    if(job==='browser-tests') {
      assert(run({EXPECT_DB:'false',DB_RESULT:'skipped'}))
      assert(!run({EXPECT_DB:'false',DB_RESULT:'failure'}))
      const report = overrides => {
        const root = mkdtempSync(join(tmpdir(), 'mikka-db-deferral-'))
        try {
          const summary = join(root, 'summary.md')
          const output = execFileSync('bash', ['-e', '-c', script], { encoding: 'utf8', env: {
            PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, CHANGES_RESULT: 'success',
            EXPECT_DB: 'false', DB_RESULT: 'skipped', DB_SELECTED: 'true', ...overrides,
          } })
          return { output, summary: readFileSync(summary, 'utf8') }
        } finally { rmSync(root, { recursive: true, force: true }) }
      }
      const bare = report({})
      assert.equal(bare.output, '::notice::Database checks deferred to merge queue\n')
      assert.equal(bare.summary, 'Database checks deferred to merge queue\n')
      const detailed = report({ DB_SUITES: '["test:example-db"]', DB_MATRIX: '{"shard":["1/2","2/2"]}' })
      const message = 'Database checks deferred to merge queue; suites: ["test:example-db"]; shard count: 2\n'
      assert.equal(detailed.output, `::notice::${message}`)
      assert.equal(detailed.summary, message)
      const selected = report({ EXPECT_DB: 'true', DB_RESULT: 'success' })
      assert.equal(selected.summary, 'Database gate: success; complete inventory validated in Changed files.\n')
      assert.equal(selected.output, '')
    }
  }
})

test('Nx commands retain Actions fail-fast and pipefail, including multiline steps', () => {
  const result = spawnSync('sh',['-c',strictCommand("printf '%s' 'literal $HOME'\nfalse\necho masked-failure")],{encoding:'utf8'})
  assert.equal(result.status,1)
  assert.equal(result.stdout,'literal $HOME')
  assert.equal(spawnSync('sh',['-c',strictCommand('false | cat')]).status,1)
})

for (const [name, source] of [
  ['new.db.test.ts', ''],
  ['new.test.ts', "import {Pool} from " + "'pg'"],
  ['dynamic.test.mjs', "const pg = await import(" + "'pg')"],
]) test(`a new DB test outside legacy inventory roots fails before selection: ${name}`, t => {
  const root = mkdtempSync(join(tmpdir(),'mikka-ci-inventory-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  mkdirSync(join(root,'tests'))
  mkdirSync(join(root,'apps/api'),{recursive:true})
  writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{'test:fixture-db':'node --test tests/fixture.db.test.ts'}}))
  writeFileSync(join(root,'tests/fixture.db.test.ts'),'')
  writeFileSync(join(root,`apps/api/${name}`),source)
  execFileSync('git',['init','-q'],{cwd:root})
  execFileSync('git',['add','.'],{cwd:root})
  assert.throws(()=>buildGraph(root),/DB test outside inventory roots/)
})

test('filesystem-based i18n and generated catalog policies cannot disappear from import-only selection', async () => {
  const commands = JSON.parse(readFileSync('scripts/ci/tasks.json','utf8'))
  for (const file of ['messages/en.json']) {
    const result = await pick(file)
    for (const command of ['pnpm test:i18n','pnpm i18n:check']) {
      const key = Object.entries(commands).find(([,task])=>task.command===command)?.[0]
      assert(result.units.includes(`ci-${key}`), `${file}: ${command}`)
    }
  }
})

// Dry run of the Desktop route: the selector's real GitHub outputs feed the real `desktop-checks` condition in CI.
test('desktop paths route CI to desktop.yml; web-only and docs-only changes do not', async () => {
  const ci = yaml.load(readFileSync('.github/workflows/ui-policy.yml', 'utf8'))
  const job = ci.jobs['desktop-checks']
  assert.equal(job.uses, './.github/workflows/desktop.yml')
  assert.deepEqual(job.with, { selected: true })
  const evaluate = (expression, context) => runInNewContext(expression.replace(/\.([\w-]+)/g, '[$1]').replace(/\[([\w-]+)\]/g, '["$1"]'), context)
  const directory = mkdtempSync(join(tmpdir(), 'desktop-route-'))
  const outputsFor = async (files, event) => {
    const output = join(directory, `output-${Math.random().toString(36).slice(2)}`)
    writeFileSync(output, '')
    const log = console.log
    console.log = () => {}
    try { emit(await select(plan, files.map(file => change(file)), { event, desktopInputs: { lockfile: false, manifest: false } }), { GITHUB_OUTPUT: output }) } finally { console.log = log }
    return Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
  }
  const routed = async (files, event = 'pull_request', draft = false) => evaluate(job.if, {
    needs: { changes: { result: 'success', outputs: await outputsFor(files, event) } },
    github: { event_name: event, event: { pull_request: { draft } } },
  })
  try {
    for (const file of ['apps/desktop/src/main/index.ts', 'apps/desktop/scripts/build.mjs']) {
      assert.equal((await outputsFor([file], 'pull_request')).desktop, 'true', file)
      for (const event of ['pull_request', 'merge_group', 'schedule', 'workflow_dispatch']) assert.equal(await routed([file], event), true, `${file} on ${event}`)
      assert.equal(await routed([file], 'pull_request', true), false, 'a draft defers Desktop like every runner-heavy lane')
      assert.equal(await routed([file], 'push'), false, 'main pushes rely on the merge-queue run of the same commit')
    }
    for (const file of ['docs/ci/incremental.md']) {
      assert.equal(await routed([file]), false, file)
      assert.equal(await routed([file], 'merge_group'), false, file)
    }
    // The page a build without the official UI compiles, reached through the plugin's virtual `mikka:application`.
    for (const event of ['pull_request', 'merge_group']) assert.equal(await routed(['apps/frontend/src/headless.ts'], event), true, event)
    // A global input no longer selects Desktop on a pull request; the merge group still runs it.
    for (const file of ['scripts/ci/select.mjs', '.github/workflows/ui-policy.yml', 'pnpm-lock.yaml', 'package.json']) {
      assert.equal(await routed([file]), false, file)
      assert.equal(await routed([file], 'merge_group'), true, file)
    }
    for (const file of ['packages/protocol/src/index.ts', '.github/workflows/desktop.yml']) assert.equal(await routed([file]), true, file)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('on a pull request Desktop follows its Nx closure, its workflow, and lockfile or manifest changes that reach it', async () => {
  const pr = (files, options = {}) => select(plan, files.map(file => typeof file === 'string' ? change(file) : file), { event: 'pull_request', ...options })
  const closure = desktopClosure(plan)
  assert.ok(closure.has('packages/protocol/src/index.ts'))
  assert.ok(!closure.has('apps/frontend/src/headless.ts'), 'the graph does not see the virtual import; DESKTOP_VIRTUAL_INPUT does')
  // A shared module Desktop imports, found through the graph rather than a path list.
  const shared = [...closure].find(file => file.startsWith('lib/') && !file.includes('.test.'))
  assert.ok(shared, 'Desktop imports at least one lib module')
  assert.equal((await pr([shared])).desktop, true, shared)
  // A file only desktop.yml runs (test:platform) is a Desktop input too.
  for (const file of desktopEntryFiles(process.cwd(), plan.files)) assert.ok(closure.has(file), file)
  assert.ok(desktopEntryFiles(process.cwd(), plan.files).some(file => file.startsWith('lib/platform/')))
  for (const [inputs, expected] of [[{ lockfile: false }, false], [{ lockfile: true }, true], [{}, true]]) {
    assert.equal((await pr(['pnpm-lock.yaml'], { desktopInputs: inputs })).desktop, expected, JSON.stringify(inputs))
  }
  for (const file of ['pnpm-workspace.yaml', 'nx.json']) assert.equal((await pr([file])).desktop, true, file)
  // A deleted module Desktop imported leaves a dangling import in the closure.
  const importer = [...closure].find(file => file.startsWith('apps/desktop/src/') && file.endsWith('.ts') && !file.includes('.test.'))
  const dangling = { ...plan, unresolved: [...plan.unresolved, { file: importer, spec: './removed-module' }] }
  assert.equal((await select(dangling, [change('lib/removed-module.ts', { status: 'D', mode: '000000' })], { event: 'pull_request' })).desktop, true)
  assert.equal((await pr([change('lib/removed-module.ts', { status: 'D', mode: '000000' })])).desktop, false, 'a deletion Desktop never imported')
  // No trustworthy diff, merge groups and docs keep their rules.
  assert.equal((await select(plan, [], { event: 'pull_request' })).desktop, true)
  assert.equal((await select(plan, [change('scripts/ci/select.mjs')], { event: 'merge_group' })).desktop, true)
  assert.equal((await pr(['docs/ci/incremental.md'])).desktop, false)
})

test('on a pull request Desktop follows every workspace package it links and every path desktop.yml runs, present or not', async () => {
  const pr = changes => select(plan, changes, { event: 'pull_request' })
  // Derived from apps/desktop/package.json, followed through each linked package's own workspace: links.
  const desktop = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8'))
  const direct = Object.entries({ ...desktop.dependencies, ...desktop.devDependencies }).filter(([, version]) => String(version).startsWith('workspace:')).map(([name]) => name)
  const roots = desktopWorkspaceRoots()
  for (const name of direct) {
    const dir = roots.find(root => JSON.parse(readFileSync(`${root}package.json`, 'utf8')).name === name)
    assert.ok(dir, `${name} is a Desktop input`)
  }
  for (const dir of ['packages/config/', 'packages/daemon/', 'packages/protocol/']) assert.ok(roots.includes(dir), dir)
  for (const file of ['packages/config/tsconfig.base.json', 'packages/config/package.json', 'packages/daemon/package.json', '.npmrc'])
    assert.equal((await pr([change(file)])).desktop, true, file)
  // A path desktop.yml runs selects Desktop even when the pull request deletes it (it is gone from the candidate tree).
  const run = desktopRunPaths()
  assert.ok(run.includes('scripts/test-accounts/cli.mjs'))
  assert.ok(run.includes('apps/desktop/scripts/install-electron.mjs'), 'a step\'s working-directory prefixes its paths')
  const withoutCli = { ...plan, files: plan.files.filter(file => file !== 'scripts/test-accounts/cli.mjs') }
  assert.ok(!desktopEntryFiles(process.cwd(), withoutCli.files).includes('scripts/test-accounts/cli.mjs'))
  for (const status of ['D', 'M']) {
    const deleted = change('scripts/test-accounts/cli.mjs', status === 'D' ? { status, mode: '000000' } : {})
    assert.equal((await select(withoutCli, [deleted], { event: 'pull_request' })).desktop, true, status)
  }
  assert.equal((await pr([change('scripts/ci/select.mjs')])).desktop, false, 'a script desktop.yml does not run')
})

test('every file the application plugin and Vite config read by name is a Desktop input on pull requests and merge groups', async () => {
  const closure = desktopClosure(plan)
  const covered = file => DESKTOP_PATH.test(file) || DESKTOP_VIRTUAL_INPUT.test(file) || closure.has(file)
  for (const source of ['apps/frontend/scripts/application-plugin.mjs', 'apps/frontend/vite.config.mjs']) {
    const text = readFileSync(source, 'utf8')
    const literals = [...text.matchAll(/resolve\((frontend|repository|renderer|actionDirectory), '([^'$`]+)'\)/g)].map(([, base, path]) =>
      ({ frontend: 'apps/frontend/', repository: '', renderer: 'apps/desktop/src/renderer/', actionDirectory: 'app/actions/' })[base] + path)
      .filter(path => !/^(?:\.\.|public$|apps\/desktop\/dist$|dist)/.test(path) && /\.[a-z]+$/.test(path))
    if (source.endsWith('application-plugin.mjs')) assert.ok(literals.includes('apps/frontend/src/headless.ts'), 'the plugin names the headless entry')
    for (const path of literals) assert.ok(covered(path), `${source} reads ${path}`)
  }
  for (const file of ['apps/frontend/index.html', 'app/actions/billing.ts', 'lib/desktop-rpc/registry.ts']) {
    for (const event of ['pull_request', 'merge_group']) assert.equal((await select(plan, [change(file)], { event })).desktop, true, `${file} on ${event}`)
  }
})
