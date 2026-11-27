import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { expectationKey, problems, report } from './ci-ok.mjs'

const workflow = yaml.load(readFileSync(new URL('../../.github/workflows/ui-policy.yml', import.meta.url), 'utf8'))
const aggregate = workflow.jobs['ci-ok']
const step = aggregate.steps.find(candidate => candidate.name === 'Require every selected CI job; accept only selected skips')
const bare = expression => String(expression).trim().replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '').replace(/\s+/g, ' ')
// A GitHub expression as JavaScript, enough for these conditions (as scripts/ci/optimization.test.mjs does).
const evaluate = (expression, context) => runInNewContext(bare(expression).replace(/\.([\w-]+)/g, '[$1]').replace(/\[([\w-]+)\]/g, '["$1"]'),
  { always: () => true, cancelled: () => false, ...context })

// Jobs CI OK does not wait for yet, each with the condition for adding it.
const NOT_YET_REQUIRED = { 'nightly-journey': 'the offline journeys have never passed; add it once a scheduled run is green' }

test('the aggregate is named CI OK, always runs, and waits for every other CI job', () => {
  assert.equal(aggregate.name, 'CI OK')
  assert.equal(aggregate.if, 'always()')
  assert.deepEqual([...aggregate.needs].sort(), Object.keys(workflow.jobs).filter(job => job !== 'ci-ok' && !Object.hasOwn(NOT_YET_REQUIRED, job)).sort())
  for (const job of Object.keys(NOT_YET_REQUIRED)) assert.ok(workflow.jobs[job], `${job} still runs`)
  for (const event of ['pull_request', 'merge_group']) assert.ok(Object.hasOwn(workflow.on, event), event)
})

test('each expectation is the needed job\'s own if:, so a skip is accepted only where selection left the job out', () => {
  const keys = Object.keys(step.env).filter(key => key.startsWith('CI_OK_EXPECT_'))
  assert.deepEqual(keys.sort(), aggregate.needs.map(expectationKey).sort())
  for (const job of aggregate.needs) {
    const condition = workflow.jobs[job].if
    const expected = step.env[expectationKey(job)]
    // Unconditional jobs (and the legacy aggregates, which run unless the run is cancelled) are always expected.
    if (condition === undefined || bare(condition) === '!cancelled()') { assert.equal(expected, 'true', job); continue }
    assert.equal(bare(expected), bare(condition), job)
  }
  assert.equal(step.env.CI_OK_NEEDS, '${{ toJSON(needs) }}')
})

test('the verdict runs main\'s copy of the script; only the introducing commit falls back to its own', () => {
  assert.match(step.run, /git fetch --no-tags --depth=1 origin main/)
  assert.match(step.run, /git show origin\/main:scripts\/ci\/ci-ok\.mjs > "\$policy"/)
  assert.match(step.run, /node "\$policy"/)
  assert.doesNotMatch(step.run, /^node scripts\/ci\/ci-ok\.mjs$/m)
  const lines = step.run.trim().split('\n')
  assert.equal(lines.at(-1).trim(), 'node "$policy"')
})

test('a draft PR fails the aggregate before it reads any result', () => {
  const draft = aggregate.steps[0]
  assert.equal(draft.if, "github.event_name == 'pull_request' && github.event.pull_request.draft == true")
  assert.match(draft.run, /exit 1/)
})

const outputs = { docs_only: 'false', core: 'true', integration: 'true', source: 'true', daemon: 'true', desktop: 'true', analytics: 'true', db: 'true' }
const context = (event, extra = {}) => ({
  github: { event_name: event, base_ref: event === 'pull_request' ? 'main' : '', ref: event === 'pull_request' ? 'refs/pull/1/merge' : 'refs/heads/main',
    repository_id: '1427517699', repository: 'aspectly-labs/Mikka', repository_owner_id: '359279274', event: { pull_request: { draft: false } } },
  needs: { changes: { result: 'success', outputs: { ...outputs, ...extra } } },
})
// What each job does under the context: its if: decides between running (here: succeeding) and being skipped.
function simulate(ctx, override = {}) {
  const needs = {}
  for (const job of aggregate.needs) {
    const condition = workflow.jobs[job].if
    const runs = job === 'changes' || condition === undefined || evaluate(condition, ctx)
    needs[job] = { result: override[job] ?? (runs ? 'success' : 'skipped') }
  }
  const env = Object.fromEntries(Object.entries(step.env).filter(([key]) => key.startsWith('CI_OK_EXPECT_'))
    .map(([key, value]) => [key, String(value === 'true' ? true : evaluate(value, ctx))]))
  return { needs, env }
}

for (const event of ['pull_request', 'merge_group', 'push', 'schedule']) test(`${event}: selected jobs succeed and the rest skip, so CI is OK`, () => {
  const { needs, env } = simulate(context(event))
  assert.deepEqual(problems(needs, env), [])
})

test('a job the selector left out passes only as a skip', () => {
  const ctx = context('pull_request', { desktop: 'false', daemon: 'false' })
  const { needs, env } = simulate(ctx)
  assert.equal(needs['desktop-checks'].result, 'skipped')
  assert.deepEqual(problems(needs, env), [])
  // A job that ran although the selection left it out means the aggregate's view and the job disagree.
  assert.deepEqual(problems({ ...needs, 'desktop-checks': { result: 'success' } }, env), ['desktop-checks: success (not selected, must be skipped)'])
})

test('failure, cancellation and an unexpected skip of a selected job each fail CI', () => {
  for (const event of ['pull_request', 'merge_group']) {
    for (const job of ['changes', 'source-checks', 'desktop-checks', 'ui-policy', 'browser-tests']) {
      for (const result of ['failure', 'cancelled', 'skipped']) {
        const { needs, env } = simulate(context(event), { [job]: result })
        assert.match(problems(needs, env).join('\n'), new RegExp(`^${job}: ${result} \\(selected, must succeed\\)`, 'm'), `${event}/${job}/${result}`)
      }
    }
  }
  const { needs, env } = simulate(context('schedule'), { 'daemon-checks': 'failure' })
  assert.deepEqual(problems(needs, env), ['daemon-checks: failure (selected, must succeed)'])
})

test('missing needs, a need without an expectation and an expectation without a need fail closed', () => {
  assert.deepEqual(problems(null, {}), ['needs: missing or empty'])
  assert.deepEqual(problems({}, {}), ['needs: missing or empty'])
  assert.deepEqual(problems({ added: { result: 'success' } }, {}), ['added: no expectation (CI_OK_EXPECT_ADDED=unset)'])
  assert.deepEqual(problems({ changes: { result: 'success' } }, { CI_OK_EXPECT_CHANGES: 'true', CI_OK_EXPECT_GONE: 'false' }),
    ['CI_OK_EXPECT_GONE: expectation for a job the aggregate does not need'])
  assert.deepEqual(problems({ changes: { result: 'success' } }, { CI_OK_EXPECT_CHANGES: '' }), ['changes: no expectation (CI_OK_EXPECT_CHANGES=)'])
})

test('the command line exits non-zero on a problem and writes the summary', () => {
  const script = fileURLToPath(new URL('./ci-ok.mjs', import.meta.url))
  const run = (needs, env) => spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH, CI_OK_NEEDS: JSON.stringify(needs), ...env }, encoding: 'utf8' })
  const ok = run({ changes: { result: 'success' }, desktop: { result: 'skipped' } }, { CI_OK_EXPECT_CHANGES: 'true', CI_OK_EXPECT_DESKTOP: 'false' })
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  assert.match(ok.stdout, /CI OK/)
  const bad = run({ changes: { result: 'success' }, desktop: { result: 'cancelled' } }, { CI_OK_EXPECT_CHANGES: 'true', CI_OK_EXPECT_DESKTOP: 'true' })
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /::error::desktop: cancelled \(selected, must succeed\)/)
  const unreadable = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH, CI_OK_NEEDS: 'not json' }, encoding: 'utf8' })
  assert.equal(unreadable.status, 1)
  assert.match(report({ changes: { result: 'success' } }, { CI_OK_EXPECT_CHANGES: 'true' }).summary, /\| changes \| yes \| success \|/)
})
