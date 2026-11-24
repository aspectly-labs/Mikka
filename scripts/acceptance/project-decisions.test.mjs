import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  AcceptanceError, CASES, MARKER, ORIGIN, REPOSITORY, actionResult, attestDeployment, buildTaskPrompt,
  decisionProof, discoverActions, publicFailure, readChatState, runProjectDecisionsAcceptance, smallArtifactBytes, successfulRelease, triggerGuard, workerReleaseProof,
} from './project-decisions.mjs'
import { decode, encode } from '../../lib/desktop-rpc/wire.ts'
import { releaseVersionGuard } from './rpc-actions.mjs'

const SHA = 'a'.repeat(40)
const OWNER = 'synthetic-owner'
const id = n => '10000000-0000-4000-8000-' + n.toString(16).padStart(12, '0')
const WS = id(1), PROJECT = id(2), ISSUE = id(3), BOT = id(4), RUN = id(5)
const KEY = id(6), CLAUDE = id(7), CODEX = id(8), DIRECTION = id(9)
const EPOCH = Date.parse('2026-11-04T12:00:00Z')
const env = (mode = 'preflight') => ({
  GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_SHA: SHA, MIKKA_EXPECTED_DEPLOYMENT_SHA: SHA, MIKKA_PROJECT_DECISIONS_MODE: mode,
  SMOKE_OWNER_EMAIL: 'test+mikka-smoke-project@example.invalid', SMOKE_OWNER_PASSWORD: 'private-password-sentinel',
})
const event = mode => ({ inputs: { mode: mode ?? 'preflight' } })
const attestation = (mode = 'preflight') => ({
  status: 'ready', issue: 1245, repository: REPOSITORY, revision: SHA, mode, workerReleaseSha: SHA,
  workerReleaseRunId: 12, checkedAt: new Date(EPOCH).toISOString(),
})
const release = kind => ({
  id: kind === 'web' ? 11 : 12, name: kind === 'web' ? 'Web deploy' : 'E2B additive runtime release',
  path: kind === 'web' ? '.github/workflows/web-deploy.yml' : '.github/workflows/e2b-official-runtime.yml',
  head_sha: SHA, head_branch: 'main', head_repository: { full_name: REPOSITORY },
  event: kind === 'web' ? 'push' : 'workflow_run', status: 'completed', conclusion: 'success', head_commit: { message: 'Add project decisions ' + MARKER },
})
const workerJobs = ({ runId = 12, published = true, inputsEvaluated = true } = {}) => [
  { id: 101, run_id: runId, name: 'test', status: 'completed', conclusion: 'success', steps: [] },
  { id: 102, run_id: runId, name: 'check', status: 'completed', conclusion: 'success', steps: [
    { number: 4, name: 'Use a Cloudflare gateway observation that serves current main', status: 'completed', conclusion: 'success' },
    { number: 5, name: 'Compare canonical worker inputs across this push and check failed attempts', status: 'completed', conclusion: inputsEvaluated ? 'success' : 'skipped' },
  ] },
  ...(published ? [
    { id: 103, run_id: runId, name: 'web-ready', status: 'completed', conclusion: 'success', steps: [] },
    { id: 104, run_id: runId, name: 'release / validate / build', status: 'completed', conclusion: 'success', steps: [
      { number: 6, name: 'Build private versioned candidates and require official file conservation', status: 'completed', conclusion: 'success' },
    ] },
    { id: 105, run_id: runId, name: 'release / templates', status: 'completed', conclusion: 'success', steps: [
      { number: 11, name: 'Make only fully accepted candidates public', status: 'completed', conclusion: 'success' },
      { number: 12, name: 'Preserve the complete public release report', status: 'completed', conclusion: 'success' },
    ] },
  ] : [
    { id: 103, run_id: runId, name: 'web-ready', status: 'completed', conclusion: 'skipped', steps: [] },
    { id: 104, run_id: runId, name: 'release', status: 'completed', conclusion: 'skipped', steps: [] },
  ]),
]

test('trigger gate binds manual main SHA and explicitly marked successful main Web deploy only', () => {
  assert.deepEqual(triggerGuard(env(), event()), { revision: SHA, mode: 'preflight' })
  const automatic = { ...env('active'), GITHUB_EVENT_NAME: 'workflow_run' }
  assert.equal(triggerGuard(automatic, { workflow_run: release('web') }).mode, 'active')
  for (const changed of [
    { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_REF: 'refs/pull/1/merge' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_SHA: 'b'.repeat(40) }, { MIKKA_EXPECTED_DEPLOYMENT_SHA: 'main' }, { MIKKA_PROJECT_DECISIONS_MODE: 'all' },
  ]) assert.throws(() => triggerGuard({ ...env(), ...changed }, event()))
  for (const changed of [
    { head_sha: 'b'.repeat(40) }, { event: 'pull_request' }, { head_branch: 'feature' },
    { head_repository: { full_name: 'fork/Mikka' } }, { conclusion: 'failure' }, { status: 'in_progress' },
    { name: 'Other workflow' }, { head_commit: { message: 'ordinary change' } },
  ]) assert.throws(() => triggerGuard(automatic, { workflow_run: { ...release('web'), ...changed } }), /trigger_rejected/)
})

test('a canonical aspectly-labs/Mikka dispatch attests against its own receipts; the old repository name is refused', async () => {
  assert.equal(REPOSITORY, 'aspectly-labs/Mikka')
  const canonical = { ...env(), GITHUB_REPOSITORY: 'aspectly-labs/Mikka', GH_TOKEN: 'private-github-token' }
  const urls = []
  const fetchImpl = async (url, init) => {
    urls.push(String(url))
    assert.equal(init.redirect, 'error')
    const parsed = new URL(url)
    if (parsed.origin === ORIGIN) return Response.json({ build: SHA })
    if (parsed.pathname.endsWith('/actions/runs/12/jobs')) return Response.json({ jobs: workerJobs({ runId: 12, published: true }) })
    return Response.json({ workflow_runs: [{ ...release('worker'), head_repository: { full_name: 'aspectly-labs/Mikka' } }] })
  }
  const proof = await attestDeployment({ env: canonical, event: event(), fetchImpl, now: () => EPOCH })
  assert.equal(proof.status, 'ready')
  assert.equal(proof.repository, 'aspectly-labs/Mikka')
  const github = urls.filter(url => url.startsWith('https://api.github.com/'))
  assert.ok(github.length > 0 && github.every(url => url.startsWith('https://api.github.com/repos/aspectly-labs/Mikka/')))
  // The repository moved: the old name is no longer the canonical one.
  assert.throws(() => triggerGuard({ ...canonical, GITHUB_REPOSITORY: 'alexj11324/Mikka' }, event()), /trigger_rejected/)
  assert.equal(successfulRelease([{ ...release('worker'), head_repository: { full_name: 'alexj11324/Mikka' } }], SHA, 'worker'), null)
  const automatic = { ...env('active'), GITHUB_EVENT_NAME: 'workflow_run' }
  assert.throws(() => triggerGuard(automatic, { workflow_run: { ...release('web'), head_repository: { full_name: 'alexj11324/Mikka' } } }), /trigger_rejected/)
  await assert.rejects(runProjectDecisionsAcceptance({ env: env(), event: event(), attestation: { ...attestation(), repository: 'alexj11324/Mikka' },
    fetchImpl: () => assert.fail('network before attestation') }), /attestation_required/)
})

test('runtime release must be exact SHA/repository/workflow/main on workflow_run or workflow_dispatch; push and legacy names are rejected', () => {
  assert.equal(successfulRelease([release('worker')], SHA, 'worker').id, 12)
  assert.equal(successfulRelease([{ ...release('worker'), event: 'workflow_dispatch' }], SHA, 'worker').id, 12)
  for (const changed of [
    { head_sha: 'b'.repeat(40) }, { id: 0 }, { event: 'push' }, { event: 'pull_request' }, { head_branch: 'feature' },
    { path: '.github/workflows/e2b-byos.yml' }, { name: 'E2B official instance runtime' }, { name: 'Unrelated' }, { conclusion: 'failure' },
    { head_repository: { full_name: 'fork/Mikka' } }, { status: 'in_progress' },
  ]) assert.equal(successfulRelease([{ ...release('worker'), ...changed }], SHA, 'worker'), null)
  assert.equal(workerReleaseProof(release('worker'), workerJobs()).status, 'published')
  assert.equal(workerReleaseProof(release('worker'), workerJobs({ published: false })).status, 'unchanged')
  // A workflow_run triggered by a failed Cloudflare deploy skips the worker-inputs check step.
  assert.deepEqual(workerReleaseProof(release('worker'), workerJobs({ published: false, inputsEvaluated: false })),
    { status: 'unproven', code: 'trigger_not_ready', runId: 12 })
  // A nested release whose validate/templates did not complete is unproven.
  const abortedNested = [...workerJobs({ published: false }).slice(0, 2),
    { id: 103, run_id: 12, name: 'web-ready', status: 'completed', conclusion: 'success', steps: [] },
    { id: 104, run_id: 12, name: 'release / recheck', status: 'completed', conclusion: 'success', steps: [] },
    { id: 105, run_id: 12, name: 'release / validate', status: 'completed', conclusion: 'skipped', steps: [] }]
  assert.equal(workerReleaseProof(release('worker'), abortedNested).status, 'unproven')
})

test('attestation never reads account credentials or forwards the GitHub token to production', async () => {
  const input = { ...env(), GH_TOKEN: 'private-github-token' }
  for (const key of ['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD']) Object.defineProperty(input, key, {
    get() { throw Error('credential was read before the workload gate') },
  })
  const calls = []
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url)
    calls.push(parsed.href)
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'error')
    if (parsed.origin === ORIGIN) {
      assert.equal(init.headers.authorization, undefined)
      return Response.json({ build: SHA })
    }
    assert.equal(parsed.origin, 'https://api.github.com')
    assert.equal(init.headers.authorization, 'Bearer private-github-token')
    if (parsed.pathname.endsWith('/e2b-official-runtime.yml/runs')) {
      assert.equal(parsed.searchParams.get('head_sha'), SHA)
      // Include a non-promoted workflow_run first to verify attestation skips it and accepts the real promoted run.
      return Response.json({ workflow_runs: [{ ...release('worker'), id: 13 }, release('worker')] })
    }
    if (parsed.pathname.endsWith('/actions/runs/13/jobs')) return Response.json({ jobs: workerJobs({ runId: 13, published: false, inputsEvaluated: false }) })
    if (parsed.pathname.endsWith('/actions/runs/12/jobs')) return Response.json({ jobs: workerJobs({ runId: 12, published: true }) })
    assert.fail('unexpected attestation URL: ' + parsed.href)
  }
  const attested = await attestDeployment({ env: input, event: event(), fetchImpl, now: () => EPOCH })
  assert.equal(attested.status, 'ready')
  assert.equal(attested.workerReleaseRunId, 12)
  assert.equal(attested.workerReleaseStatus, 'published')
  assert.ok(calls.length >= 6)
  await assert.rejects(attestDeployment({ env: input, event: event(), now: () => EPOCH,
    fetchImpl: async () => Response.json({ build: 'b'.repeat(40) }) }), /build_mismatch/)
  await assert.rejects(attestDeployment({ env: input, event: event(), now: () => EPOCH,
    fetchImpl: async url => new URL(url).origin === ORIGIN ? Response.json({ build: SHA }) : Response.json({ workflow_runs: [] }) }), /worker_release/)
  // A failed-deploy workflow_run alone cannot satisfy worker_release.
  await assert.rejects(attestDeployment({ env: input, event: event(), now: () => EPOCH,
    fetchImpl: async url => {
      const parsed = new URL(url)
      if (parsed.origin === ORIGIN) return Response.json({ build: SHA })
      if (parsed.pathname.endsWith('/runs')) return Response.json({ workflow_runs: [{ ...release('worker'), id: 13 }] })
      return Response.json({ jobs: workerJobs({ runId: 13, published: false, inputsEvaluated: false }) })
    } }), /worker_release/)
})

test('decision proof rejects forged identity, substituted models, reconstructed records and ungrounded changes', () => {
  const scope = { projectId: PROJECT, workspaceId: WS, issueId: ISSUE, botId: BOT, ownerId: OWNER, runId: RUN,
    model: 'claude-haiku-5-5', harness: 'claude_code', kind: 'redirect', selectedOptionId: 'revised', predecessorId: id(10), directionToken: DIRECTION }
  const record = {
    id: id(11), projectId: PROJECT, workspaceId: WS, issueId: ISSUE, ownerId: OWNER, runId: RUN, kind: 'redirect',
    recordedBy: { kind: 'agent', id: RUN, userId: OWNER, botId: BOT, runId: RUN, modelId: scope.model,
      harness: scope.harness, identityAssurance: 'run_token' },
    captureMode: 'live', provenance: 'recorded', recordStatus: 'active', title: 'private-title',
    reason: 'private-reason ' + DIRECTION, summary: 'private-summary', selectedOptionId: 'revised',
    predecessorDecisionIds: [id(10)], options: [
      { id: 'baseline', disposition: 'abandoned', reason: 'private-option-reason' }, { id: 'revised', disposition: 'selected' },
    ], sources: [{ sourceRef: id(12), role: 'evidence', locator: { type: 'run', id: RUN } }],
  }
  const proof = decisionProof(record, scope)
  for (const privateText of ['private-title', 'private-reason', 'private-summary', 'private-option-reason', DIRECTION])
    assert.ok(!JSON.stringify(proof).includes(privateText))
  for (const changed of [
    { ownerId: 'another-owner' }, { projectId: id(100) }, { runId: id(101) },
    { recordedBy: { ...record.recordedBy, kind: 'human' } }, { recordedBy: { ...record.recordedBy, id: id(102) } },
    { recordedBy: { ...record.recordedBy, modelId: 'other-model' } },
    { recordedBy: { ...record.recordedBy, identityAssurance: 'authenticated_user' } },
    { captureMode: 'human_marked' }, { captureMode: 'reconstructed', provenance: 'inferred' },
    { recordStatus: 'retracted' }, { sources: [] },
    { sources: [{ sourceRef: id(12), role: 'evidence', locator: { type: 'run', id: id(99) } }] },
    { predecessorDecisionIds: [] }, { selectedOptionId: 'baseline' }, { reason: 'no token', summary: 'no token' },
  ]) assert.throws(() => decisionProof({ ...record, ...changed }, scope))
  const bot = { ...record, runId: null, kind: 'confirm', recordedBy: { ...record.recordedBy, kind: 'bot', id: BOT, runId: null, identityAssurance: 'host_context' },
    sources: [{ sourceRef: id(12), role: 'evidence', locator: { type: 'issue', id: ISSUE } }] }
  assert.equal(decisionProof(bot, { ...scope, actor: 'bot', kind: 'confirm' }).actor, 'bot')
})

test('errors project provider 402 without raw error details', () => {
  assert.deepEqual(publicFailure(new AcceptanceError('provider_refused', 'blocked', {
    providerStatus: 402, providerKind: 'balance', password: 'private-password', serverCode: 'secret-body', raw: 'private-text',
  })), { status: 'blocked', code: 'provider_refused', providerStatus: 402, providerKind: 'balance' })
  assert.deepEqual(publicFailure(new Error('private-password')), { status: 'failed', code: 'acceptance_failed' })
})

const names = ['saveProject', 'listProjects', 'saveIssue', 'setProjectIssues', 'getIssueThread', 'changeModelOrder']
const refs = { saveProject: 'projects.saveProject', listProjects: 'projects.listProjects', saveIssue: 'issues.saveIssue',
  setProjectIssues: 'projects.setProjectIssues', getIssueThread: 'agents.getIssueThread', changeModelOrder: 'model-order.changeModelOrder' }
const PIN = '370cc898-local-prebuilt-1'
const document = (pin = PIN) => '<script type="module" crossorigin src="/mikka/assets/index-aBc123.js?dpl=' + pin + '"></script>'
// The public action list of a Vite web release (apps/frontend/scripts/build.mjs, lib/renderer-actions.mjs).
const manifest = (used = names) => {
  const modules = {}
  for (const name of used) { const [module, exported] = refs[name].split('.'); (modules[module] ??= []).push(exported) }
  return { version: 1, target: 'web', rendererBuild: 'a'.repeat(64), usedActions: used.map(name => refs[name]), modules }
}
const actionList = (path, used) => path.startsWith('/mikka/renderer-manifest.json') ? new Response(null, { status: 404 })
  : path === '/mikka/renderer-actions.json?dpl=' + PIN ? Response.json(manifest(used)) : null
const rpc = result => Response.json({ version: 1, ok: true, result: encode(result) })

test('only published allowlisted UI actions are discovered; RPC results are decoded', async () => {
  const paths = []
  const result = await discoverActions(async path => {
    paths.push(path)
    return actionList(path) ?? new Response(document() + '<script src="https://evil.invalid/secret.js"></script>')
  })
  assert.deepEqual(result, refs)
  assert.ok(paths.every(path => !path.includes('evil.invalid')))
  assert.deepEqual(actionResult({ version: 1, ok: true, result: { project: { id: 'ok' } } }, 'saveProject'), { project: { id: 'ok' } })
  assert.throws(() => actionResult({ version: 1, ok: true, result: {} }, 'deleteWorkspace'), /action_not_allowed/)
  assert.throws(() => actionResult({ version: 1, ok: true, result: { error: 'secret-body' } }, 'saveProject'), /action_refused/)
  assert.throws(() => actionResult({ version: 1, ok: false, error: { code: 'authRequired' } }, 'saveProject'), /action_refused/)
  assert.throws(() => actionResult(null, 'saveProject'), /action_refused/)
})

test('discovery visits real UI routes and reads one release-pinned public action list', async () => {
  const paths = [], diagnostics = {}
  const result = await discoverActions(async path => { paths.push(path); return actionList(path) ?? new Response(document()) }, diagnostics)
  assert.deepEqual(result, refs)
  assert.deepEqual(paths, ['/en', '/en?section=projects', '/en/settings?section=models',
    '/mikka/renderer-manifest.json?dpl=' + PIN, '/mikka/renderer-actions.json?dpl=' + PIN])
  assert.equal(diagnostics.manifestSha256.length, 64)
  delete diagnostics.manifestSha256
  assert.deepEqual(diagnostics, { transport: 'rpc', rpcVersion: 1, required: names, found: names, missing: [],
    pagesRead: 3, pagesFailed: 0, manifestsRead: 1, manifestsFailed: 0, rendererBuild: 'a'.repeat(64), deploymentId: PIN })
})

test('mixed releases, foreign entries and a refused or foreign action list publish no action', async () => {
  for (const pages of [() => document(), path => document(path === '/en' ? 'release-1' : 'release-2'),
    () => '<script type="module" src="https://evil.invalid/mikka/assets/index-aBc123.js"></script>']) {
    const diagnostics = {}, paths = []
    const result = await discoverActions(async path => {
      paths.push(path)
      if (path.includes('renderer-')) return path.includes('manifest') ? new Response(null, { status: 404 })
        : Response.json({ ...manifest(), target: 'desktop' })
      return new Response(pages(path))
    }, diagnostics)
    assert.deepEqual(result, {})
    assert.deepEqual(diagnostics.missing, names)
    assert.ok(!paths.some(path => path.includes('evil.invalid')))
  }
})

test('missing actions are reported as fixed names and counts before any case mutation', async () => {
  const f = fixture()
  const fetchImpl = async (input, init) => {
    const path = new URL(input).pathname
    return path === '/mikka/renderer-actions.json' ? Response.json(manifest(names.filter(name => name !== 'getIssueThread')))
      : f.fetchImpl(input, init)
  }
  const report = await runProjectDecisionsAcceptance({ env: env(), event: event(), attestation: attestation(), fetchImpl, now: f.now, wait: f.wait })
  assert.equal(report.status, 'partial')
  assert.deepEqual(report.actionDiscovery.missing, ['getIssueThread'])
  assert.deepEqual(report.actionDiscovery.found, names.filter(name => name !== 'getIssueThread'))
  assert.equal(report.actionDiscovery.manifestsRead, 1)
  assert.ok(report.cases.every(item => item.status === 'blocked' && item.code === 'action_missing' && item.cleanup.state === 'not_created'))
  assert.ok(f.calls.filter(call => call.method !== 'GET').every(call => ['/api/auth/sign-in/email', '/api/auth/sign-out'].includes(call.path)))
  const serialized = JSON.stringify(report)
  for (const forbidden of ['private-password-sentinel', 'private-cookie-sentinel']) assert.ok(!serialized.includes(forbidden))
})

test('invalid attestation and foreign origins fail before reading or sending account values', async () => {
  const input = env()
  for (const name of ['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD']) Object.defineProperty(input, name, {
    get() { throw Error('private credential getter should not be reached') },
  })
  let calls = 0
  const fetchImpl = async () => { calls++; throw Error('unexpected') }
  await assert.rejects(runProjectDecisionsAcceptance({ env: input, event: event(), attestation: { ...attestation(), revision: 'b'.repeat(40) }, fetchImpl, now: () => EPOCH }), /attestation_required/)
  await assert.rejects(runProjectDecisionsAcceptance({ env: { ...env(), MIKKA_ACCEPTANCE_BASE_URL: 'https://evil.invalid/mikka' },
    event: event(), attestation: attestation(), fetchImpl, now: () => EPOCH }), /origin_rejected/)
  assert.equal(calls, 0)
})

test('task prompt uses the structured issue and leaves the future live direction unknown', () => {
  const prompt = buildTaskPrompt({ marker: 'fixture', projectId: PROJECT, workspaceId: WS, issueId: ISSUE, item: CASES[1], botRecord: true })
  assert.ok(prompt.includes('dispatch_bot_computer'))
  assert.ok(prompt.includes('existing issue ' + ISSUE))
  assert.ok(prompt.includes('Omit projectId, workspaceId and issueId'))
  assert.ok(!prompt.includes(DIRECTION))
  assert.ok(prompt.includes('Do not create a second issue or task'))
})

test('workflow attests before OIDC and uploads only two explicit sanitized reports', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/project-decisions-acceptance.yml', import.meta.url), 'utf8')
  assert.ok(workflow.indexOf('project-decisions.mjs --attest') < workflow.indexOf('Infisical/secrets-action'))
  assert.ok(!workflow.includes('workflow_run'), 'per-service releases publish no Web deploy run to follow')
  assert.ok(workflow.includes('ref: ' + '$' + '{{ github.sha }}'))
  assert.ok(workflow.includes('secret-path: /'))
  assert.ok(workflow.includes('recursive: false'))
  assert.ok(workflow.includes('project-decisions-report/attestation.json'))
  assert.ok(workflow.includes('project-decisions-report/report.json'))
  assert.ok(!workflow.includes('path: .cache'))
})

function fixture({ active = false, noWorking = false, providerFailureAtChat = false, submitStatus = 202, invalidSubmitReceipt = false } = {}) {
  let tick = EPOCH, counter = 100, orderCounter = 500
  const ids = () => id(counter++)
  const sources = CASES.map((item, index) => ({
    id: id(20 + index), model: item.model, harness: item.harness, credentialOwnerId: OWNER,
    source: item.kind === 'api_key' ? { kind: 'api_key', keyId: KEY } : { kind: 'subscription', connectionId: item.provider === 'claude' ? CLAUDE : CODEX },
  }))
  let entries = sources.map(value => ({ ...value }))
  const projects = [], issues = [], bots = [], calls = [], sequence = []
  const order = () => ({ location: 'cloud', cloudReady: true, customized: true, entries: entries.map(entry => ({
    ...entry, ...(entry.model === 'deepseek-flash' && !providerFailureAtChat ? { block: { reason: 'balance' } } : {}),
  })), candidates: sources, cloudModels: Object.fromEntries(entries.map(entry => [entry.id, 'ready'])) })
  const menu = bot => ({
    groups: [
      { kind: 'apiKey', options: [{ id: 'apikey:' + KEY + ':deepseek-flash', modelId: 'deepseek-flash', provider: 'deepseek' }] },
      { kind: 'subscription', options: [
        { id: CLAUDE, modelId: 'claude-haiku-5-5', provider: 'claude' },
        { id: CODEX, modelId: 'gpt-6-luna', provider: 'codex' },
      ] },
    ], current: bot?.chosen ? { modelId: bot.item.model, kind: bot.item.kind === 'api_key' ? 'apiKey' : 'subscription', available: true } : null,
  })
  const botForRun = runId => bots.find(bot => [bot.runId, bot.reviewId, bot.verifyId].includes(runId))
  const task = bot => ({
    task: { id: bot.taskId, issueId: bot.issueId, userId: OWNER, botId: bot.id, revision: 1, sourceEventId: id(90),
      status: bot.cancelled ? 'cancelled' : bot.steered ? 'completed' : 'running', candidateId: bot.steered ? bot.candidateId : null },
    attempts: [
      { stage: 'execute', runId: bot.runId, status: bot.steered ? 'passed' : 'running' },
      ...(bot.steered ? ['review', 'verify'].map(stage => ({ stage, runId: bot[stage + 'Id'], status: 'passed',
        candidateId: bot.candidateId, output: { requestEpoch: id(90) } })) : []),
    ], candidates: bot.steered ? [{ id: bot.candidateId, runId: bot.runId }] : [],
  })
  const evidence = (bot, runId) => {
    const resourceId = bot.item.provider === 'claude' ? CLAUDE : CODEX
    return { run: {
      id: runId, botId: bot.id, issueId: bot.issueId, status: bot.steered ? 'succeeded' : bot.stopped ? 'stopped' : 'running',
      model: bot.item.model, harness: bot.item.harness, credentialType: 'subscription',
      subscriptionRoute: bot.item.harness === 'codex' ? 'codex_cli' : 'claude_code_cli',
      executionIdentity: { version: 1, requester: OWNER, executionPrincipal: OWNER, outputOwner: OWNER, botId: bot.id,
        botOwner: OWNER, workspaceId: WS, personalResourcePolicy: 'requester_only',
        billingAccount: { model: { kind: 'subscription', ownerId: OWNER, resourceId }, runtime: { kind: 'e2b', ownerId: OWNER } },
        resourceBindings: [{ kind: 'subscription', id: resourceId, ownerId: OWNER, access: 'owner' }] },
    }, artifacts: bot.steered ? [{ id: bot.artifactId, title: bot.name + '.md', latestVersion: 1,
      url: '/mikka/api/artifacts/' + bot.artifactId + '/versions/1/download' }] : [] }
  }
  const records = bot => {
    if (!bot?.sent || (providerFailureAtChat && bot.item.kind === 'api_key')) return []
    const base = { projectId: bot.projectId, workspaceId: WS, issueId: bot.issueId, ownerId: OWNER,
      captureMode: 'live', provenance: 'recorded', recordStatus: 'active', reason: 'private-reason', summary: 'private-summary',
      runId: bot.runId, recordedBy: { kind: 'agent', id: bot.runId, userId: OWNER, botId: bot.id, runId: bot.runId,
        modelId: bot.item.model, harness: bot.item.harness, identityAssurance: 'run_token' },
      sources: [{ sourceRef: bot.sourceRef, role: 'evidence', locator: { type: 'run', id: bot.runId } }] }
    return [
      { ...base, id: bot.chooseId, kind: 'choose', title: bot.name + ' choose', selectedOptionId: 'baseline',
        options: [{ id: 'baseline', disposition: 'selected' }, { id: 'alternative', disposition: 'rejected', reason: 'private-option' }] },
      ...(bot.botRecord ? [{ ...base, id: bot.botDecisionId, kind: 'confirm', title: bot.name + ' bot', runId: null,
        recordedBy: { ...base.recordedBy, kind: 'bot', id: bot.id, runId: null, identityAssurance: 'host_context' },
        sources: [{ sourceRef: bot.sourceRef, role: 'evidence', locator: { type: 'issue', id: bot.issueId } }] }] : []),
      ...(bot.steered ? [{ ...base, id: bot.redirectId, kind: 'redirect', title: bot.name + ' redirect',
        selectedOptionId: 'revised', reason: 'private-direction ' + bot.token, predecessorDecisionIds: [bot.chooseId],
        options: [{ id: 'baseline', disposition: 'abandoned', reason: 'private-option' }, { id: 'revised', disposition: 'selected' }] }] : []),
    ]
  }
  async function fetchImpl(input, init) {
    const url = new URL(input), path = url.pathname.replace(/^\/mikka/, ''), method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ path, method })
    assert.equal(url.origin, ORIGIN)
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.authorization, undefined)
    if (path === '/api/version') return Response.json({ build: SHA })
    if (path === '/api/auth/sign-in/email') return Response.json({}, { headers: { 'set-cookie': 'session=private-cookie-sentinel; HttpOnly' } })
    assert.equal(init.headers.cookie, 'session=private-cookie-sentinel')
    if (path === '/api/auth/get-session') return Response.json({ user: { id: OWNER, email: env().SMOKE_OWNER_EMAIL } })
    if (path === '/api/auth/sign-out') return Response.json({ success: true })
    if (path === '/renderer-manifest.json') return new Response(null, { status: 404 })
    if (path === '/renderer-actions.json') return Response.json(manifest())
    if ((path === '/en' || path === '/en/settings') && method === 'GET') return new Response(document())
    if (path === '/api/rpc' && method === 'POST') {
      assert.equal(init.headers['x-mikka-rpc'], '1')
      assert.equal(body.version, 1)
      const name = names.find(name => refs[name] === body.action), args = decode(body.args)
      assert.ok(active || ['listProjects', 'getIssueThread'].includes(name), 'preflight must not mutate')
      const value = args[0]
      if (name === 'listProjects') return rpc(projects)
      if (name === 'saveProject') {
        const project = { ...value, id: ids(), userId: OWNER, issueIds: [], revision: 1 }; projects.push(project); return rpc({ project })
      }
      if (name === 'saveIssue') {
        const issue = { ...value, id: ids(), userId: OWNER, scope: 'personal', linearTargetVerified: false, revision: 1 }
        issues.push(issue); return rpc({ issue })
      }
      if (name === 'setProjectIssues') {
        const project = projects.find(project => project.id === value.id)
        Object.assign(project, { issueIds: value.issueIds, revision: 2 }); return rpc({ project })
      }
      if (name === 'getIssueThread') return rpc({ thread: { rootRunId: args[1], modelFallback: [] }, chunks: [] })
      if (name === 'changeModelOrder') {
        if (value.kind === 'remove') entries = entries.filter(entry => entry.id !== value.id)
        if (value.kind === 'add') entries.push(...value.entries.map(entry => ({ ...entry, id: id(orderCounter++), credentialOwnerId: OWNER })))
        if (value.kind === 'reorder') entries = value.ids.map(key => entries.find(entry => entry.id === key))
        return rpc(order())
      }
    }
    if (path === '/api/settings/model-order') return Response.json(order())
    if (path === '/api/settings/api-keys') return Response.json({ keys: [{ id: KEY, provider: 'deepseek' }] })
    if (path === '/api/subscriptions') return Response.json({ connections: [
      { id: CLAUDE, provider: 'claude', state: 'connected', paused: false },
      { id: CODEX, provider: 'codex', state: 'connected', paused: false },
    ] })
    if (path === '/api/mobile/threads') return Response.json({ threads: [] })
    if (path === '/api/settings/workspace-bots') return Response.json({ bots: [{ status: 'idle', runningThreads: 0 }] })
    if (path === '/api/bots' && method === 'GET') return Response.json([{ id: BOT, name: 'Smoke Bot', ownerId: OWNER, workspaceId: WS }, ...bots])
    if (path === '/api/bots' && method === 'POST') {
      const item = CASES.find(item => body.name.endsWith(item.id)), issue = issues.at(-1), project = projects.at(-1)
      const bot = { ...body, id: ids(), ownerId: OWNER, workspaceId: WS, item, issueId: issue.id, projectId: project.id,
        taskId: ids(), runId: ids(), reviewId: ids(), verifyId: ids(), candidateId: ids(), artifactId: ids(),
        chooseId: ids(), redirectId: ids(), sourceRef: ids(), botDecisionId: ids() }
      bots.push(bot); return Response.json(bot)
    }
    if (path === '/api/mobile/model') {
      const bot = bots.find(bot => bot.id === (body?.bot ?? url.searchParams.get('bot')))
      if (method === 'PUT') bot.chosen = true
      return Response.json(menu(bot))
    }
    if (path === '/api/mobile/chat/stop') return Response.json({ stopped: true })
    if (path === '/api/mobile/chat' && method === 'GET') {
      const bot = bots.find(bot => bot.id === url.searchParams.get('bot'))
      const failed = providerFailureAtChat && bot?.sent && bot.item.kind === 'api_key'
      // stopChatTurn leaves a failed turn's lastError in the normal ChatView.
      return Response.json({ botId: bot?.id, enabled: true, working: false, error: failed ? 'private-provider-error-sentinel' : null,
        failure: failed ? { kind: 'failed' } : null, items: failed ? [{ from: 'person', text: 'private-user-message-sentinel' }] : [],
        sources: {}, artifacts: {}, reactions: {} })
    }
    if (path === '/api/agents/eve/v1/session' && method === 'POST') {
      const bot = bots.find(bot => bot.id === url.searchParams.get('botId'))
      assert.deepEqual(body.clientContext, { expectedOwnerId: OWNER, expectedWorkspaceId: WS })
      assert.match(new Headers(init.headers).get('x-mikka-submission-id'), /^[a-f0-9-]{36}$/)
      bot.sent = true; bot.botRecord = body.message.includes('"title":"' + bot.name + ' bot"')
      sequence.push('sent:' + bot.item.id)
      return Response.json(invalidSubmitReceipt ? { queued: true } : { ok: true, sessionId: 'wrun_project', deliveryId: 'delivery_fixture' }, { status: submitStatus })
    }
    if (path === '/api/factory/tasks') {
      const bot = bots.find(bot => bot.issueId === url.searchParams.get('issueId'))
      return Response.json({ issueId: url.searchParams.get('issueId'), tasks: bot?.sent && !(providerFailureAtChat && bot.item.kind === 'api_key') ? [{ id: bot.taskId }] : [] })
    }
    if (/^\/api\/factory\/tasks\/[^/]+$/.test(path)) {
      const bot = bots.find(bot => bot.taskId === path.split('/').at(-1))
      if (method === 'POST') bot.cancelled = true
      return Response.json(task(bot))
    }
    if (path.startsWith('/api/projects/')) {
      const projectId = path.split('/')[3], bot = bots.find(bot => bot.projectId === projectId)
      return Response.json({ projectId, workspaceId: WS, decisions: records(bot) })
    }
    if (/^\/api\/runs\/[^/]+\/evidence$/.test(path)) {
      const runId = path.split('/')[3], bot = botForRun(runId)
      return Response.json(evidence(bot, runId))
    }
    if (path.startsWith('/api/mobile/bots/')) {
      const bot = bots.find(bot => bot.id === path.split('/').at(-1))
      return Response.json({ threads: bot.sent && !(providerFailureAtChat && bot.item.kind === 'api_key') ? [{ id: bot.runId }] : [] })
    }
    if (/^\/api\/mobile\/threads\/[^/]+\/stop$/.test(path)) {
      botForRun(path.split('/')[4]).stopped = true
      return Response.json({ stopped: true })
    }
    if (/^\/api\/mobile\/threads\/[^/]+$/.test(path)) {
      const bot = botForRun(path.split('/')[4])
      if (method === 'GET') {
        sequence.push('working:' + bot.item.id)
        return Response.json({ working: !(noWorking && bot.item.id === 'official_claude') && !bot.steered && !bot.stopped })
      }
      assert.ok(sequence.includes('working:' + bot.item.id), 'steering requires a prior working observation')
      bot.token = /Direction token ([a-f0-9-]{36})/.exec(body.text)?.[1]
      assert.ok(bot.token)
      bot.steered = true; sequence.push('steered:' + bot.item.id)
      return Response.json({ queued: true }, { status: 202 })
    }
    if (path.startsWith('/api/artifacts/')) {
      const bot = bots.find(bot => bot.artifactId === path.split('/')[3])
      return new Response('project-decisions:' + bot.name + '\nroute=revised\n' + bot.token + '\n')
    }
    throw Error('unexpected synthetic request')
  }
  return { calls, sequence, projects, bots, fetchImpl, now: () => tick, wait: async ms => { tick += ms } }
}

test('DeepSeek balance blocker is independent; preflight checks both subscriptions and signs out', async () => {
  const f = fixture()
  const report = await runProjectDecisionsAcceptance({ env: env(), event: event(), attestation: attestation(), ...f })
  assert.deepEqual(report.cases.map(item => item.status), ['blocked', 'ready', 'ready'])
  assert.equal(report.cases[0].code, 'source_blocked')
  assert.equal(report.cases[0].block, 'balance')
  assert.equal(report.status, 'partial')
  assert.equal(report.sessionClosed, true)
  assert.equal(f.projects.length, 0)
  assert.ok(f.calls.every(call => call.method === 'GET' || ['/api/auth/sign-in/email', '/api/auth/sign-out'].includes(call.path)))
  for (const secret of ['private-password-sentinel', 'private-cookie-sentinel', env().SMOKE_OWNER_EMAIL])
    assert.ok(!JSON.stringify(report).includes(secret))
})

test('active subscriptions need working-time steering, same-run decisions, one Bot record and verified artifacts', async () => {
  const f = fixture({ active: true })
  const report = await runProjectDecisionsAcceptance({ env: env('active'), event: event('active'), attestation: attestation('active'),
    ...f, newId: () => DIRECTION })
  assert.deepEqual(report.cases.map(item => [item.status, item.code]), [['blocked', 'source_blocked'], ['pass', undefined], ['pass', undefined]])
  assert.equal(report.status, 'partial', 'blocked DeepSeek is never called a pass')
  assert.equal(report.botRecord.actor, 'bot')
  assert.equal(f.bots.filter(bot => bot.botRecord).length, 1)
  for (const result of report.cases.slice(1)) {
    assert.equal(result.midRun.observedWorking, true)
    assert.deepEqual(result.decisions.map(decision => decision.kind), ['choose', 'redirect'])
    assert.equal(result.decisions[1].source.id, result.runId)
    assert.equal(result.checks.length, 2)
    assert.equal(result.cleanup.state, 'stopped_evidence_retained')
    assert.equal(result.cleanup.orderRestored, true)
  }
  for (const text of ['private-reason', 'private-summary', 'private-option', 'private-direction', DIRECTION, env().SMOKE_OWNER_PASSWORD])
    assert.ok(!JSON.stringify(report).includes(text))
  assert.equal(report.sessionClosed, true)
})



test('a promotion after the version check cannot move fixture reads or writes to another release', async () => {
  // Two releases of the same commit publish the same action names (a rerun gets
  // a new deployment id). The public gateway (cloudflare/web/gateway.mjs) sends
  // an API call to its x-deployment-id, else to the current release; the
  // version check always reads the current release.
  const OLD = PIN, NEW = 'b0b0b0b0-2-1', f = fixture({ active: true })
  let current = OLD, listed = false, promotedAt = -1
  const traffic = []
  const fetchImpl = async (input, init) => {
    const url = new URL(input), path = url.pathname, method = init.method ?? 'GET'
    const header = init.headers['x-deployment-id'], version = path === '/mikka/api/version'
    const routed = path.startsWith('/mikka/api/') || /\.[^/]+$/.test(path)
    const release = version || !routed ? current : header ?? url.searchParams.get('dpl') ?? current
    traffic.push({ path, method, header, release })
    if (path === '/mikka/renderer-actions.json') listed = true
    const response = await f.fetchImpl(input, init)
    // The promotion lands right after a version check that the old release passed.
    if (version && listed && current === OLD) { current = NEW; promotedAt = traffic.length }
    return response
  }
  const report = await runProjectDecisionsAcceptance({ env: env('active'), event: event('active'), attestation: attestation('active'),
    ...f, fetchImpl, newId: () => DIRECTION })
  assert.deepEqual(report.cases.map(item => [item.status, item.code]), [['blocked', 'source_blocked'], ['pass', undefined], ['pass', undefined]])
  assert.equal(report.actionDiscovery.deploymentId, OLD)
  assert.ok(promotedAt > 0, 'the current release changed during the run')
  const scoped = call => call.path.startsWith('/mikka/api/') && call.path !== '/mikka/api/version' && !call.path.startsWith('/mikka/api/auth/')
  const after = traffic.slice(promotedAt).filter(scoped), writes = after.filter(call => call.method !== 'GET')
  assert.ok(writes.some(call => call.path === '/mikka/api/rpc') && writes.some(call => call.path === '/mikka/api/bots'))
  assert.deepEqual([...new Set(after.map(call => call.release))], [OLD], 'every later read and write stays on the discovered release')
  assert.deepEqual([...new Set(after.map(call => call.header))], [OLD])
  // The version check stays unpinned, so a later build change is still seen.
  assert.ok(traffic.filter(call => call.path === '/mikka/api/version').every(call => call.header === undefined))
  assert.ok(traffic.filter(call => call.path.startsWith('/mikka/api/auth/')).every(call => call.header === undefined))
})

test('an API binding updated in place after the first version check stops the run before any fixture write', async () => {
  // The Web release and its build stay the same; only the bound API's source
  // (apiBuild in cloudflare/web/version.mjs) changes once discovery is done.
  const f = fixture({ active: true }), traffic = []
  let listed = false, changedAt = -1
  const fetchImpl = async (input, init) => {
    const url = new URL(input), path = url.pathname
    traffic.push({ path, method: init.method ?? 'GET' })
    if (path === '/mikka/renderer-actions.json') listed = true
    if (path === '/mikka/api/version') {
      if (listed && changedAt < 0) changedAt = traffic.length - 1
      return Response.json({ build: SHA, apiBuild: changedAt >= 0 ? 'd'.repeat(40) : 'c'.repeat(40) })
    }
    return f.fetchImpl(input, init)
  }
  const report = await runProjectDecisionsAcceptance({ env: env('active'), event: event('active'), attestation: attestation('active'),
    ...f, fetchImpl, newId: () => DIRECTION })
  assert.ok(changedAt > 0)
  assert.ok(report.cases.every(item => item.status === 'blocked' && item.code === 'build_mismatch'), JSON.stringify(report.cases))
  assert.deepEqual(traffic.slice(changedAt).filter(call => call.method !== 'GET' && !call.path.startsWith('/mikka/api/auth/')), [])
  assert.equal(report.sessionClosed, true)
})

test('the release guard fixes build and apiBuild at the first check', () => {
  const same = releaseVersionGuard(SHA)
  assert.equal(same({ build: SHA, apiBuild: 'c'.repeat(40) }), true)
  assert.equal(same({ build: SHA, apiBuild: 'c'.repeat(40) }), true)
  assert.equal(same({ build: SHA, apiBuild: 'd'.repeat(40) }), false, 'only the API source changed')
  assert.equal(same({ build: SHA }), false, 'the API source disappeared')
  assert.equal(same({ build: 'b'.repeat(40), apiBuild: 'c'.repeat(40) }), false)
  const local = releaseVersionGuard(SHA)
  assert.equal(local({ build: SHA }), true, 'a runtime without a separate API binding reports no apiBuild')
  assert.equal(local({ build: SHA, apiBuild: 'c'.repeat(40) }), false)
})

test('chat reader accepts only its normal route and shape while preserving live control state', async () => {
  const view = { items: [{ text: 'private-chat-body' }], working: false, error: 'private-chat-error', failure: { kind: 'failed' },
    streamRunId: 'wrun_live_workflow' }
  const request = async path => {
    assert.equal(path, '/api/mobile/chat?bot=' + BOT)
    return Response.json(view)
  }
  assert.deepEqual(await readChatState(request, BOT), { working: false, streamRunId: 'wrun_live_workflow', failed: true })
  assert.deepEqual(await readChatState(async () => Response.json({ ...view, working: true, failure: null }), BOT),
    { working: true, streamRunId: 'wrun_live_workflow', failed: false })
  await assert.rejects(readChatState(async () => { throw Error('must not request another path') }, '../other'), /bot_scope/)
  for (const status of [401, 403, 500])
    await assert.rejects(readChatState(async () => Response.json(view, { status }), BOT),
      error => error.message === 'http_refused' && publicFailure(error).httpStatus === status)
  for (const value of [{ error: 'private-envelope' }, { ...view, items: null }, { ...view, working: 'false' },
    { ...view, error: {} }, { ...view, streamRunId: 123 }, { ...view, failure: { kind: 'unexpected' } }])
    await assert.rejects(readChatState(async () => Response.json(value), BOT), /response_invalid/)
  for (const failure of [{ kind: 'hosted', code: 'points_exhausted' }, { kind: 'subscription', notice: 'quota' },
    { kind: 'wake', code: 'wake_exhausted' }, { kind: 'failed' }])
    assert.equal((await readChatState(async () => Response.json({ ...view, failure }), BOT)).failed, true)
})


test('historical provider errors in a normal ChatView do not block cleanup or later subscriptions', async () => {
  const f = fixture({ active: true, providerFailureAtChat: true })
  const report = await runProjectDecisionsAcceptance({ env: env('active'), event: event('active'), attestation: attestation('active'),
    ...f, newId: () => DIRECTION })
  assert.deepEqual(report.cases.map(item => [item.status, item.code]), [['blocked', 'provider_refused'], ['pass', undefined], ['pass', undefined]])
  assert.equal(report.cases[0].providerStatus, undefined, 'a chat failure cannot prove an upstream HTTP status')
  assert.equal(report.cases[0].cleanup.state, 'stopped_evidence_retained')
  assert.equal(report.cases[0].cleanup.orderRestored, true)
  assert.equal(report.cases[0].cleanup.failure, undefined)
  assert.deepEqual(f.sequence.filter(item => item.startsWith('sent:')), ['sent:api_deepseek', 'sent:official_claude', 'sent:official_codex'])
  assert.equal(report.sessionClosed, true)
  for (const forbidden of ['private-provider-error-sentinel', 'private-user-message-sentinel'])
    assert.ok(!JSON.stringify(report).includes(forbidden))
})

test('an ended thread cannot pass as mid-run steering and does not stop the other subscription', async () => {
  const f = fixture({ active: true, noWorking: true })
  const report = await runProjectDecisionsAcceptance({ env: env('active'), event: event('active'), attestation: attestation('active'),
    ...f, newId: () => DIRECTION })
  assert.equal(report.cases[1].code, 'mid_run_window_missed')
  assert.equal(report.cases[1].status, 'blocked')
  assert.ok(!f.sequence.includes('steered:official_claude'))
  assert.equal(report.cases[2].status, 'pass')
})

test('artifact download enforces a small byte bound before retaining arbitrary model output', async () => {
  assert.equal((await smallArtifactBytes(new Response('ok'))).toString(), 'ok')
  await assert.rejects(smallArtifactBytes(new Response('x'.repeat(4097))), /artifact_content/)
})

test('native message admission requires HTTP 202 and its actual receipt', async () => {
  for (const options of [{ submitStatus: 200 }, { invalidSubmitReceipt: true }]) {
    const f = fixture({ active: true, ...options })
    const report = await runProjectDecisionsAcceptance({ env: env('active'), event: event('active'), attestation: attestation('active'), ...f })
    assert.equal(report.cases.slice(1).every(row => row.status === 'blocked'), true)
    assert.equal(report.cases.slice(1).every(row => row.code === (options.submitStatus ? 'http_refused' : 'response_invalid')), true)
    assert.equal(report.sessionClosed, true)
  }
})
