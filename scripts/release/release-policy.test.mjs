import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  checkedReleasePolicy, committedPromoters, isPromoter, MANDATORY_CHECKS, policyFromContents, promoterGateExpression,
  publicPolicy, readReleasePolicy, requireCommittedPromoters, requirePromoters,
} from './release-policy.mjs'
import { desktopRouteGuard, publicCheckRun, routeGuardSummary, runReleaseChecks } from './release-checks.mjs'
import { DAEMON_INPUTS, isDaemonInput, verifyDaemonPromotion } from './daemon-promotion.mjs'

const yaml = createRequire(import.meta.url)('js-yaml')
const workflow = name => yaml.load(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8'))
const committed = JSON.parse(readFileSync(new URL('../../config/release-promoters.json', import.meta.url), 'utf8')).promoters
const policy = (patch = {}) => ({ version: 1, autoProduction: false, mobileProduction: false, promoters: committed,
  requiredChecks: { production: [], desktop: [], mobile: [] }, ...patch })
const owner = { id: 183887963, login: 'alexj11324' }, devin = { id: 158243242, login: 'devin-ai-integration[bot]' }

test('the policy schema: promoters by stable id and login, extensible checks, everything else fails closed', () => {
  const checked = checkedReleasePolicy(policy())
  assert.deepEqual(checked.promoters, [owner, devin])
  assert.deepEqual(checked.requiredChecks.desktop, MANDATORY_CHECKS.desktop, 'the route guard holds even when the policy omits it')
  assert.deepEqual(checked.requiredChecks.production, [])
  const e2e = { name: 'browser-e2e', kind: 'check-run', repository: 'public', checkRun: 'Browser e2e' }
  assert.deepEqual(checkedReleasePolicy(policy({ requiredChecks: { production: [e2e], desktop: [e2e], mobile: [] } })).requiredChecks.desktop,
    [...MANDATORY_CHECKS.desktop, e2e])
  for (const [patch, code] of [
    [{ version: 2 }, /versionRequired/], [{ autoProduction: 'false' }, /flagUnreadable/], [{ mobileProduction: undefined }, /flagUnreadable/],
    [{ promoters: undefined }, /promotersRequired/], [{ promoters: {} }, /promotersRequired/],
    [{ promoters: [{ id: '183887963', login: 'alexj11324', note: 'x' }] }, /promoterInvalid/],
    [{ promoters: [{ id: 183887963, login: 'alexj11324' }] }, /promoterInvalid/],
    [{ promoters: [{ id: 183887963, login: 'alexj11324', note: 'x', extra: 1 }] }, /promoterInvalid/],
    [{ promoters: [{ id: 118344674, login: 'github-merge-queue[bot]', note: 'merges' }] }, /promoterForbidden/],
    [{ promoters: [{ id: 41898282, login: 'github-actions[bot]', note: 'jobs' }] }, /promoterForbidden/],
    [{ promoters: [{ id: 5, login: 'github-merge-queue[bot]', note: 'renamed id' }] }, /promoterForbidden/],
    [{ promoters: [...committed, { ...committed[0], login: 'other' }] }, /promoterDuplicate/],
    [{ requiredChecks: undefined }, /requiredChecksInvalid/],
    [{ requiredChecks: { production: [], desktop: [] } }, /requiredChecksInvalid/],
    [{ requiredChecks: { production: [{ name: 'x', kind: 'shell', run: 'true' }], desktop: [], mobile: [] } }, /checkInvalid/],
    [{ requiredChecks: { production: [], desktop: [], mobile: [e2e] } }, /checkUnsupported/],
    [{ requiredChecks: { production: [], desktop: [{ name: 'desktop-route-guard', kind: 'check-run', repository: 'public', checkRun: 'x' }], mobile: [] } }, /checkInvalid/],
  ]) assert.throws(() => checkedReleasePolicy(policy(patch)), code, JSON.stringify(patch))
})

test('both the dispatcher and the re-run actor must be listed; an empty list admits nobody', () => {
  const checked = checkedReleasePolicy(policy())
  requirePromoters(checked, { actor: devin, triggeringActor: owner })
  assert.equal(isPromoter(checked, { id: '158243242', login: devin.login }), true)
  for (const [actors, code] of [
    [{ actor: { id: 7, login: 'outsider' }, triggeringActor: owner }, /actorNotPromoter/],
    [{ actor: owner, triggeringActor: { id: 7, login: 'outsider' } }, /triggeringActorNotPromoter/],
    [{ actor: { id: owner.id, login: 'renamed' }, triggeringActor: owner }, /actorNotPromoter/],
    [{ actor: { login: owner.login }, triggeringActor: owner }, /actorNotPromoter/],
  ]) assert.throws(() => requirePromoters(checked, actors), code)
  assert.throws(() => requirePromoters(checkedReleasePolicy(policy({ promoters: [] })), { actor: owner, triggeringActor: owner }), /noPromoters/)
})

test('the committed public gate list must equal the authoritative private list', () => {
  assert.deepEqual(committedPromoters(), [owner, devin])
  requireCommittedPromoters(checkedReleasePolicy(policy()))
  requireCommittedPromoters(checkedReleasePolicy(policy({ promoters: [...committed].reverse() })))
  for (const promoters of [committed.slice(0, 1), [...committed, { id: 9, login: 'agent[bot]', note: 'x' }], []])
    assert.throws(() => requireCommittedPromoters(checkedReleasePolicy(policy({ promoters }))), /promotersDiverged/)
  assert.equal(promoterGateExpression(), `(contains(fromJSON('["183887963","158243242"]'), github.actor_id) && contains(fromJSON('["alexj11324","devin-ai-integration[bot]"]'), github.actor) && contains(fromJSON('["alexj11324","devin-ai-integration[bot]"]'), github.triggering_actor))`)
})

test('every promotion job carries exactly the committed promoter gate before any secret', () => {
  const gate = promoterGateExpression()
  const jobs = [['cloudflare-app-deploy.yml', 'deploy-application'], ['cloudflare-app-deploy.yml', 'pipeline'], ['cloudflare-app-deploy.yml', 'pipeline-production'],
    ['desktop-release.yml', 'preflight'], ['mobile-next-update.yml', 'update'], ['publish-daemon.yml', 'publish']]
  for (const [file, job] of jobs) {
    const condition = String(workflow(file).jobs[job].if)
    assert.equal(condition.split(gate).length - 1, 1, `${file}:${job}`)
    // No other promoter list may appear in a job condition.
    assert.equal((condition.match(/fromJSON\(/g) ?? []).length, 3, `${file}:${job}`)
  }
  for (const file of ['desktop-release.yml', 'mobile-next-update.yml', 'publish-daemon.yml'])
    assert.doesNotMatch(readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8'), /github\.actor_id == '183887963'/, file)
  // The deployment workflow keeps the owner id only as the automatic merge-push identity, never for a dispatch.
  const deploy = workflow('cloudflare-app-deploy.yml')
  for (const name of ['deploy-application', 'pipeline-production']) assert.doesNotMatch(deploy.jobs[name].if, /actor_id == '183887963'/, name)
  assert.match(deploy.jobs.pipeline.if, /github\.event_name == 'workflow_run' && \(github\.actor_id == '183887963' \|\|/)
  // Where the gate sits: Desktop gates only a hand dispatch, mobile everything but staging, npm only the latest dispatch.
  assert.match(workflow('desktop-release.yml').jobs.preflight.if, /\(github\.event_name != 'workflow_dispatch' \|\| \(contains/)
  assert.match(workflow('mobile-next-update.yml').jobs.update.if, /\(inputs\.phase == 'stage' \|\| inputs\.phase == '' \|\| \(contains/)
  assert.match(workflow('publish-daemon.yml').jobs.publish.if, /\(github\.event_name == 'push' \|\| \(contains/)
})

test('the policy is read from private main and its Git blob is verified', async () => {
  const bytes = Buffer.from(JSON.stringify(policy()))
  const record = { type: 'file', path: 'docs/operations/releases/deploy-pipeline.json', encoding: 'base64', size: bytes.length,
    content: bytes.toString('base64'), sha: createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') }
  assert.equal(policyFromContents(record).blob, record.sha)
  assert.throws(() => policyFromContents({ ...record, sha: '0'.repeat(40) }), /policyUnreadable/)
  const seen = []
  const fetchImpl = async (url, init) => { seen.push([url, init.headers.authorization]); return Response.json(record) }
  assert.deepEqual((await readReleasePolicy({ owner: 'aspectly-labs', token: 'ghs_fixture_value', fetchImpl })).policy, policy())
  assert.deepEqual(seen, [['https://api.github.com/repos/aspectly-labs/mikka-cloud/contents/docs/operations/releases/deploy-pipeline.json?ref=main', 'Bearer ghs_fixture_value']])
  await assert.rejects(readReleasePolicy({ owner: 'evil', token: 'ghs_fixture_value', fetchImpl }), /policyUnreadable/)
  await assert.rejects(readReleasePolicy({ owner: 'aspectly-labs', token: 'ghs_fixture_value', fetchImpl: async () => new Response('no', { status: 404 }) }), /policyUnreadable/)
  assert.deepEqual(publicPolicy(checkedReleasePolicy(policy()), 'desktop').requiredChecks, MANDATORY_CHECKS.desktop)
})

test('the desktop route guard must run, with the hosted checkout, for the exact pairing, and never skip', async () => {
  const tap = (pass, fail = 0, skipped = 0) => `TAP version 13\n# tests ${pass + fail + skipped}\n# pass ${pass}\n# fail ${fail}\n# cancelled 0\n# skipped ${skipped}\n# todo 0\n`
  assert.equal(routeGuardSummary(tap(3)).pass, 3)
  for (const output of [tap(2, 1), tap(0, 0, 3), tap(2), '']) assert.throws(() => routeGuardSummary(output), /desktopRouteGuardFailed/)
  const source = 'a'.repeat(40), overlay = 'b'.repeat(40)
  const env = { MIKKA_DESKTOP_SOURCE: source, MIKKA_UI_OVERLAY_SHA: overlay, PATH: process.env.PATH }
  const root = new URL('../../', import.meta.url).pathname
  const fake = (heads, output) => (command, args) => {
    if (command === 'git') return heads[args[1]] + '\n'
    if (output instanceof Error) throw output
    return output
  }
  const heads = { [root]: source, [root + '.hosted-ui']: overlay }
  const exists = (await import('node:fs')).existsSync(root + '.hosted-ui/core')
  if (exists) {
    assert.equal(desktopRouteGuard({ root, env, run: fake(heads, tap(3)) }).pass, 3)
    assert.throws(() => desktopRouteGuard({ root, env, run: fake({ ...heads, [root]: 'c'.repeat(40) }, tap(3)) }), /desktopSourceMismatch/)
    assert.throws(() => desktopRouteGuard({ root, env, run: fake({ ...heads, [root + '.hosted-ui']: 'c'.repeat(40) }, tap(3)) }), /desktopOverlayMismatch/)
    assert.throws(() => desktopRouteGuard({ root, env, run: fake(heads, tap(0, 0, 3)) }), /desktopRouteGuardFailed/)
    assert.throws(() => desktopRouteGuard({ root, env, run: fake(heads, Object.assign(new Error('exit 1'), { stdout: tap(2, 1) })) }), /desktopRouteGuardFailed/)
  }
  // Without the hosted checkout the guard fails instead of skipping.
  assert.throws(() => desktopRouteGuard({ root: '/nonexistent', env, run: fake(heads, tap(3)) }), /hostedCheckoutRequired/)
  assert.throws(() => desktopRouteGuard({ root, env: { ...env, MIKKA_UI_OVERLAY_SHA: '' }, run: fake(heads, tap(3)) }), /desktopPairingRequired/)
})

test('required checks: mandatory ones cannot be dropped, unknown ones fail, check runs must have passed on the released commit', async () => {
  const sha = 'a'.repeat(40)
  const guard = async () => ({ pass: 3 })
  const e2e = { name: 'browser-e2e', kind: 'check-run', repository: 'public', checkRun: 'Browser e2e' }
  const read = runs => async path => { assert.match(path, new RegExp(`^commits/${sha}/check-runs\\?check_name=Browser%20e2e&`)); return { check_runs: runs } }
  const ok = [{ name: 'Browser e2e', head_sha: sha, status: 'completed', conclusion: 'success' }]
  assert.deepEqual((await runReleaseChecks('desktop', { checks: [...MANDATORY_CHECKS.desktop, e2e], sourceCommit: sha, read: read(ok),
    builtin: { 'desktop-route-guard': guard } })).map(result => result.name), ['desktop-route-guard', 'browser-e2e'])
  await assert.rejects(runReleaseChecks('desktop', { checks: [e2e], sourceCommit: sha, read: read(ok) }), /mandatoryCheckMissing/)
  await assert.rejects(runReleaseChecks('production', { checks: [{ name: 'mobile-smoke', kind: 'builtin' }], builtin: {} }), /unknownCheck/)
  await assert.rejects(runReleaseChecks('mobile', { checks: [e2e], read: read(ok) }), /unknownCheck/)
  await assert.rejects(runReleaseChecks('production', { checks: undefined }), /checksRequired/)
  for (const runs of [[], [{ ...ok[0], conclusion: 'failure' }], [{ ...ok[0], head_sha: 'b'.repeat(40) }], [{ ...ok[0], status: 'in_progress' }]])
    await assert.rejects(publicCheckRun(e2e, sha, read(runs)), /checkRunMissing/)
})

test('npm latest moves only for a promoter dispatch of a successful staged push run with the same daemon inputs', async () => {
  const sha = 'e'.repeat(40), staged = 'f'.repeat(40)
  const env = (patch = {}) => ({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_ACTOR_ID: '158243242', GITHUB_ACTOR: 'devin-ai-integration[bot]',
    GITHUB_TRIGGERING_ACTOR: 'devin-ai-integration[bot]', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'aspectly-labs/Mikka',
    GITHUB_WORKFLOW_REF: 'aspectly-labs/Mikka/.github/workflows/publish-daemon.yml@refs/heads/main', GITHUB_SHA: sha, GITHUB_WORKFLOW_SHA: sha,
    STAGED_RUN: '41', ...patch })
  const reader = (change = {}) => async path => {
    if (path === 'actions/runs/41') return { id: 41, run_attempt: 1, path: '.github/workflows/publish-daemon.yml', event: 'push', head_branch: 'main',
      status: 'completed', conclusion: 'success', head_sha: staged, ...change.run }
    if (path === 'actions/runs/41/attempts/1/jobs?per_page=100') return change.jobs ?? { jobs: [{ name: 'publish', conclusion: 'success',
      steps: [{ name: 'Publish with npm trusted publishing and provenance', conclusion: 'success' }] }] }
    if (path === `compare/${staged}...${sha}`) return { status: 'ahead', merge_base_commit: { sha: staged }, files: [{ filename: 'apps/web/page.tsx' }], ...change.compare }
    assert.fail('unexpected read ' + path)
  }
  assert.deepEqual(await verifyDaemonPromotion({ env: env(), read: reader() }), { stagedRun: '41', stagedSource: staged, source: sha })
  for (const [patch, change, code] of [
    [{ GITHUB_ACTOR_ID: '7', GITHUB_ACTOR: 'outsider' }, {}, /dispatchNeedsPromoter/],
    [{ GITHUB_TRIGGERING_ACTOR: 'outsider' }, {}, /dispatchNeedsPromoter/],
    [{ GITHUB_EVENT_NAME: 'push' }, {}, /dispatchNeedsPromoter/],
    [{ GITHUB_WORKFLOW_REF: 'aspectly-labs/Mikka/.github/workflows/publish-daemon.yml@refs/heads/edit' }, {}, /workflowIdentity/],
    [{ GITHUB_WORKFLOW_SHA: 'd'.repeat(40) }, {}, /workflowIdentity/],
    [{ STAGED_RUN: '' }, {}, /stagedRunRequired/],
    [{}, { run: { event: 'workflow_dispatch' } }, /stagedRunUnsuccessful/],
    [{}, { run: { conclusion: 'failure' } }, /stagedRunUnsuccessful/],
    [{}, { jobs: { jobs: [{ name: 'publish', conclusion: 'success', steps: [{ name: 'Publish with npm trusted publishing and provenance', conclusion: 'skipped' }] }] } }, /stagedRunNotPublished/],
    [{}, { compare: { status: 'diverged' } }, /stagedRunOffMain/],
    [{}, { compare: { files: [{ filename: 'packages/daemon/src/index.ts' }] } }, /daemonInputsChanged/],
    [{}, { compare: { files: [{ filename: 'other', previous_filename: 'pnpm-lock.yaml' }] } }, /daemonInputsChanged/],
  ]) await assert.rejects(verifyDaemonPromotion({ env: env(patch), read: reader(change) }), code, JSON.stringify({ patch, change }))
  // The input list is exactly the workflow's push filter, and the workflow publishes next unless dispatched.
  const daemon = workflow('publish-daemon.yml')
  assert.deepEqual(daemon.on.push.paths, DAEMON_INPUTS)
  assert.equal(isDaemonInput('packages/daemon/x.ts'), true)
  assert.equal(isDaemonInput('packages/daemonic/x.ts'), false)
  assert.equal(daemon.jobs.publish.env.MIKKA_DAEMON_CHANNEL, "${{ github.event_name == 'workflow_dispatch' && 'latest' || 'next' }}")
  const steps = daemon.jobs.publish.steps.map(step => step.name ?? step.run ?? step.uses)
  assert.ok(steps.indexOf('Verify the staged daemon run before publishing to latest') < steps.indexOf('Publish with npm trusted publishing and provenance'))
  assert.ok(steps.indexOf('Verify the staged daemon run before publishing to latest') < steps.indexOf('Prepare release version and check registry'))
})

test('Desktop reads the policy before release, gates evidence before signing, and runs checks from the trusted verifier', () => {
  const desktop = workflow('desktop-release.yml')
  const preflight = desktop.jobs.preflight.steps.map(step => step.name)
  assert.ok(preflight.indexOf('Read the reviewed release policy') < preflight.indexOf('Verify the promoted Cloudflare Web before allocating macOS'))
  assert.equal(desktop.jobs.preflight.steps.find(step => step.name === 'Verify the promoted Cloudflare Web before allocating macOS').env.MIKKA_RELEASE_POLICY,
    '${{ steps.policy.outputs.policy }}')
  const macos = desktop.jobs.macos.steps
  const index = name => macos.findIndex(step => step.name === name)
  const checks = index('Run the required release checks for this exact public and hosted pairing')
  assert.ok(checks > index('Install private UI runtime dependencies without license scripts'))
  assert.ok(checks < macos.findIndex(step => step.with?.['secret-name'] === 'APPLE_DEVELOPER_ID_P12_BASE64'))
  assert.ok(checks < index('Package signed macOS app'))
  assert.equal(macos[checks].run, 'node "$RUNNER_TEMP/release-verifier/scripts/release/release-checks.mjs" desktop')
  assert.equal(desktop.jobs.macos.env.MIKKA_RELEASE_POLICY, '${{ needs.preflight.outputs.policy }}')
})
