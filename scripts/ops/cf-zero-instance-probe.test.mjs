import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyApp, globToRegExp, loadManifest, parseArgs, probe, runningCount, summarize }
  from './cf-zero-instance-probe.mjs'

const manifestSource = JSON.stringify({
  schema: 'mikka.dev/zero-residency/v1',
  declarations: [
    { appPattern: 'mikka-task-sandbox*', mode: 'on-demand', ownerIssue: 3080 },
    { appPattern: 'mikka-api-*-businessapi', mode: 'retire-under-#1954', ownerIssue: 3079 },
    { appPattern: 'mikka-litellm*', mode: 'managed', ownerIssue: 3079 },
    { appPattern: 'mikka-eve-*', mode: 'always-on-tracked', ownerIssue: 3078 },
  ],
})
const manifest = loadManifest(manifestSource)

const ok = (result, extras = {}) => ({
  ok: true, status: 200, json: async () => ({ success: true, result, ...extras }),
})

function fetchFor(apps, details = {}) {
  const calls = []
  return Object.assign(async url => {
    calls.push(url)
    if (url.endsWith('/containers/applications?per_page=500')) return ok(apps)
    const match = /containers\/applications\/([^/?]+)$/.exec(url)
    if (match && decodeURIComponent(match[1]) in details) return ok(details[decodeURIComponent(match[1])])
    return { ok: false, status: 404, json: async () => ({ success: false, errors: [{ code: 1001 }] }) }
  }, { calls })
}

const app = (id, name, policy = 'default') =>
  ({ id, name, scheduling_policy: policy, max_instances: 1, updated_at: '2026-11-21T00:00:00Z' })

test('parseArgs validates watch evidence and numeric windows', () => {
  assert.deepEqual(parseArgs(['--manifest', 'm.json']), { manifest: 'm.json', out: null, secretsFile: null,
    allow: [], watch: false, interval: 5, duration: 60 })
  assert.throws(() => parseArgs(['--watch']), /--out/)
  assert.throws(() => parseArgs(['--interval', '0']), /interval/)
  assert.throws(() => parseArgs(['--bogus']), /Unknown argument/)
  const args = parseArgs(['--watch', '--out', 'w.jsonl', '--interval', '2', '--duration', '10',
    '--allow', 'mikka-api-*, mikka-eve-*'])
  assert.equal(args.interval, 2)
  assert.equal(args.duration, 10)
  assert.deepEqual(args.allow, ['mikka-api-*', 'mikka-eve-*'])
})

test('globToRegExp matches mikka app patterns and rejects unsafe patterns', () => {
  assert.ok(globToRegExp('mikka-api-*-businessapi').test('mikka-api-abc123-1-businessapi'))
  assert.ok(!globToRegExp('mikka-api-*-businessapi').test('mikka-api-abc123-1-businessapi-staging'))
  assert.ok(globToRegExp('mikka-task-sandbox*').test('mikka-task-sandbox-staging'))
  assert.throws(() => globToRegExp('bad pattern?'), /Invalid application pattern/)
})

test('classifyApp uses manifest modes; undeclared apps are never exempt', () => {
  assert.deepEqual(classifyApp('mikka-task-sandbox', manifest),
    { declaration: 'mikka-task-sandbox*', mode: 'on-demand', exempt: false, ownerIssue: 3080 })
  assert.equal(classifyApp('mikka-eve-candidate', manifest).exempt, true)
  assert.equal(classifyApp('mikka-unknown-thing', manifest).mode, 'undeclared')
  assert.equal(classifyApp('mikka-unknown-thing', manifest).exempt, false)
  assert.equal(classifyApp('mikka-unknown-thing', manifest, ['mikka-unknown-*']).exempt, true)
})

test('runningCount sums runtime health keys and falls back to placements', () => {
  assert.deepEqual(runningCount({ health: { instances: { active: 1, assigned: 1 } }, instances: 3 }),
    { running: 2, breakdown: { active: 1, assigned: 1 } })
  assert.deepEqual(runningCount({ health: { instances: { active: 0, starting: 1 } } }),
    { running: 1, breakdown: { active: 0, starting: 1 } })
  assert.deepEqual(runningCount({ instances: 2 }), { running: 2, breakdown: null })
  assert.deepEqual(runningCount({}), { running: null, breakdown: null })
})

test('summarize keeps only allowlisted fields, never configuration', () => {
  const detail = {
    scheduling_policy: 'default', max_instances: 1, instances: 1, updated_at: '2026-11-21T01:00:00Z',
    health: { summary: 'healthy', instances: { active: 1, assigned: 0 } },
    configuration: { image: 'registry.example/secret', environment_variables: [{ name: 'KEY', value: 'hidden' }] },
  }
  const record = summarize(app('a030c142-bc8a-46cc-b9cf-06ab3140a54e', 'mikka-api-x-1-businessapi'), detail)
  assert.equal(record.running, 1)
  assert.equal(record.placements, 1)
  assert.equal(JSON.stringify(record).includes('hidden'), false)
  assert.equal('configuration' in record, false)
})

test('probe flags non-exempt running apps, unverified counts and undeclared apps', async () => {
  const apps = [
    app('46fff0884b2e4f7c80ed1835499431de', 'mikka-task-sandbox', 'durable_object'),
    app('a03e5056-e265-4060-ad33-65e93fc9a40d', 'mikka-litellm'),
    app('a1111111-1111-4111-8111-111111111111', 'mikka-eve-candidate'),
    app('a2222222-2222-4222-8222-222222222222', 'rogue-app'),
    app('a3333333-3333-4333-8333-333333333333', 'mikka-api-x-1-businessapi'),
  ]
  const details = {
    '46fff0884b2e4f7c80ed1835499431de': { health: { instances: { active: 0, assigned: 0 } }, instances: 0 },
    'a03e5056-e265-4060-ad33-65e93fc9a40d': { health: { instances: { active: 0, assigned: 0 } }, instances: 0 },
    'a1111111-1111-4111-8111-111111111111': { health: { instances: { active: 1, assigned: 0 } }, instances: 1 },
    'a2222222-2222-4222-8222-222222222222': { health: { instances: { active: 0, starting: 0 } }, instances: 0 },
    'a3333333-3333-4333-8333-333333333333': {},
  }
  const fetchImpl = fetchFor(apps, details)
  const report = await probe({ token: 't'.repeat(40), accountId: 'a'.repeat(32), manifest, fetchImpl })
  assert.equal(report.totals.applications, 5)
  assert.equal(report.totals.running, 1)
  assert.deepEqual(report.violations.map(v => [v.name, v.reason]), [
    ['mikka-api-x-1-businessapi', 'unverified'],
  ])
  assert.deepEqual(report.exemptRunning, [{ name: 'mikka-eve-candidate', mode: 'always-on-tracked', running: 1 }])
  assert.equal(report.applications.find(a => a.name === 'rogue-app').mode, 'undeclared')
  assert.ok(fetchImpl.calls.length >= 6)
})

test('probe reports a clean idle window with exit-relevant empty violations', async () => {
  const apps = [
    app('46fff0884b2e4f7c80ed1835499431de', 'mikka-task-sandbox', 'durable_object'),
    app('a03e5056-e265-4060-ad33-65e93fc9a40d', 'mikka-litellm'),
  ]
  const details = Object.fromEntries(apps.map(a => [a.id, { health: { instances: { active: 0, assigned: 0 } }, instances: 0 }]))
  const report = await probe({ token: 't'.repeat(40), accountId: 'b'.repeat(32), manifest, fetchImpl: fetchFor(apps, details) })
  assert.equal(report.violations.length, 0)
  assert.equal(report.totals.running, 0)
})
