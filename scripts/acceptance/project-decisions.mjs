#!/usr/bin/env node
/**
 * #1245: ordinary smoke-owner HTTP acceptance. No SQL, fabricated sessions,
 * credential export, test backdoors, repository writes or external messages.
 * Unit fixtures test this driver; only a production report can establish live acceptance.
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { isSmokeAccountEmail } from '../../lib/smoke-account.ts'
import { assertFlashTestModel } from '../test-model-policy.mjs'
import {
  AcceptanceError as ProviderAcceptanceError, assertRunEvidence, assertWorkspaceIdle,
  caseOrderPlan, orderFingerprint, ownedSource, providerReceipt, verifyCheckRuns,
} from './model-order-cases.mjs'
import { discoverRpcActions, releaseHeaders, releaseVersionGuard, RPC_HEADERS, rpcBody, rpcResult } from './rpc-actions.mjs'
import { publicRepositoryId } from '../cloudflare-source.mjs'
import { lastPublishedRelease, runtimeInputsDigest } from '../e2b/runtime-inputs.mjs'
import { assertReportIdentity, downloadReleaseReport, readReleaseArtifact, TEMPLATE_KINDS } from '../e2b/runtime-report.mjs'

export const ORIGIN = 'https://app.aspectlylabs.com'
export const REPOSITORY = 'aspectly-labs/Mikka'
export const MARKER = '[project-map-acceptance]'
export const CASES = Object.freeze([
  { id: 'api_deepseek', model: 'deepseek-flash', provider: 'deepseek', harness: 'claude_code', kind: 'api_key' },
  { id: 'official_claude', model: 'claude-haiku-5-5', provider: 'claude', harness: 'claude_code', kind: 'subscription' },
  { id: 'official_codex', model: 'gpt-6-luna', provider: 'codex', harness: 'codex', kind: 'subscription' },
])
const ACTIONS = Object.freeze({ saveProject: 'projects.saveProject', listProjects: 'projects.listProjects', saveIssue: 'issues.saveIssue',
  setProjectIssues: 'projects.setProjectIssues', getIssueThread: 'agents.getIssueThread', changeModelOrder: 'model-order.changeModelOrder' })
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const digest = value => createHash('sha256').update(value).digest('hex')
const deterministicId = value => { const h = digest(value); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-8' + h.slice(17, 20) + '-' + h.slice(20, 32) }
const finiteStatus = value => Number.isInteger(value) && value >= 100 && value <= 599
const terminalRuns = new Set(['succeeded', 'failed', 'stopped', 'cancelled'])
const terminalTasks = new Set(['cancelled', 'revoked', 'completed', 'succeeded'])
const codes = new Set([
  'configuration_required', 'trigger_rejected', 'origin_rejected', 'deployment_proof', 'build_mismatch',
  'worker_release', 'attestation_required', 'account_required', 'sign_in_failed',
  'session_missing', 'session_identity', 'workspace_missing', 'request_failed', 'http_refused',
  'response_invalid', 'action_missing', 'action_not_allowed', 'action_refused', 'source_missing',
  'source_ambiguous', 'source_blocked', 'cloud_unavailable', 'workspace_busy', 'order_restore_unavailable',
  'order_restore_conflict', 'order_changed', 'previous_fixture', 'project_scope', 'structure_missing',
  'issue_scope', 'bot_scope', 'model_selection', 'model_changed', 'task_scope', 'task_missing',
  'task_blocked', 'task_timeout', 'run_scope', 'run_model', 'run_credential', 'run_identity',
  'provider_refused', 'decision_missing', 'decision_duplicate', 'decision_scope', 'decision_actor',
  'decision_model', 'decision_capture', 'decision_source', 'decision_options', 'decision_direction',
  'mid_run_window_missed', 'steer_not_queued', 'bot_decision_missing', 'checks_missing',
  'artifact_missing', 'artifact_scope', 'artifact_content', 'cleanup_incomplete', 'acceptance_failed',
])
export class AcceptanceError extends Error {
  constructor(code, status = 'blocked', detail = {}) {
    super(codes.has(code) ? code : 'acceptance_failed')
    this.status = status === 'failed' ? 'failed' : 'blocked'
    this.detail = detail
  }
}
const check = (condition, code, status = 'blocked', detail) => { if (!condition) throw new AcceptanceError(code, status, detail) }

/** Exact allowlist; upstream error messages, bodies and reasons are never report fields. */
export function publicFailure(error) {
  if (!(error instanceof AcceptanceError) && !(error instanceof ProviderAcceptanceError))
    return { status: 'failed', code: 'acceptance_failed' }
  const detail = error.detail ?? {}
  return {
    status: error.status === 'failed' ? 'failed' : 'blocked',
    code: codes.has(error.message) ? error.message : 'acceptance_failed',
    ...(finiteStatus(detail.httpStatus) ? { httpStatus: detail.httpStatus } : {}),
    ...(finiteStatus(detail.providerStatus) ? { providerStatus: detail.providerStatus } : {}),
    ...(['balance', 'auth', 'unavailable', 'quota'].includes(detail.providerKind) ? { providerKind: detail.providerKind } : {}),
    ...(['checking', 'quota', 'expired', 'paused', 'missing', 'keyRefused', 'balance', 'providerUnavailable', 'noDevice'].includes(detail.block) ? { block: detail.block } : {}),
  }
}

/** This one GET returns a normal ChatView with a persistent business error.
 * Keep only control state; neither the historical error nor chat bodies leave here. */
export async function readChatState(request, botId) {
  check(uuid(botId), 'bot_scope', 'failed')
  const response = await request('/api/mobile/chat?bot=' + botId)
  check(response.ok, 'http_refused', 'blocked', { httpStatus: response.status })
  const value = await response.json().catch(() => null)
  const failure = value?.failure
  const knownFailure = failure === null || (failure && typeof failure === 'object' && !Array.isArray(failure)
    && (failure.kind === 'failed'
      || (failure.kind === 'hosted' && typeof failure.code === 'string')
      || (failure.kind === 'subscription' && typeof failure.notice === 'string')
      || (failure.kind === 'wake' && ['wake_failed', 'wake_start_unconfirmed', 'wake_exhausted'].includes(failure.code))))
  check(value && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray(value.items) && typeof value.working === 'boolean'
    && (value.error === null || typeof value.error === 'string')
    && (value.streamRunId === undefined || typeof value.streamRunId === 'string')
    && knownFailure, 'response_invalid')
  return { working: value.working, streamRunId: value.streamRunId ?? null, failed: failure !== null }
}

export function triggerGuard(env, event) {
  check(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REF === 'refs/heads/main', 'trigger_rejected')
  const mode = env.MIKKA_PROJECT_DECISIONS_MODE ?? (env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? 'preflight' : 'active')
  check(['preflight', 'active'].includes(mode), 'trigger_rejected')
  const revision = env.MIKKA_EXPECTED_DEPLOYMENT_SHA
  check(sha(revision), 'configuration_required')
  if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    const run = event?.workflow_run
    check(run?.name === 'Web deploy' && run.event === 'push' && run.status === 'completed' && run.conclusion === 'success'
      && run.head_branch === 'main' && run.head_repository?.full_name === REPOSITORY && run.head_sha === revision
      && run.head_commit?.message?.includes(MARKER) && mode === 'active', 'trigger_rejected')
  } else check(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_SHA === revision
    && (event?.inputs?.mode ?? 'preflight') === mode, 'trigger_rejected')
  return { revision, mode }
}
const WORKER_RELEASE_NAME = 'E2B additive runtime release'
const WORKER_RELEASE_PATH = '.github/workflows/e2b-official-runtime.yml'
const WORKER_INPUTS_STEP = 'Compare canonical worker inputs across this push and check failed attempts'
const WORKER_PROMOTED_WEB_STEP = 'Verify the promoted Cloudflare Web before allocating template builders'
const WORKER_VALIDATE_STEP = 'Build private versioned candidates and require official file conservation'
const WORKER_PUBLISH_STEP = 'Make only fully accepted candidates public'
const WORKER_REPORT_STEP = 'Preserve the complete public release report'
const PUBLIC_REPOSITORY_ID = Number(publicRepositoryId)

export function matchingReleases(runs, revision, kind) {
  const name = kind === 'web' ? 'Web deploy' : WORKER_RELEASE_NAME
  const path = kind === 'web' ? '.github/workflows/web-deploy.yml' : WORKER_RELEASE_PATH
  // E2B additive runtime release never publishes on push (github.event_name != 'push');
  // it evaluates or publishes only on workflow_run (Cloudflare promotion) or workflow_dispatch.
  const events = kind === 'web' ? ['push', 'workflow_dispatch'] : ['workflow_run', 'workflow_dispatch']
  return (Array.isArray(runs) ? runs : []).filter(run => Number.isSafeInteger(run?.id) && run.id > 0
    && run.name === name && run.path === path && events.includes(run.event)
    && run.head_branch === 'main' && run.head_sha === revision
    && (!run.repository || run.repository.full_name === REPOSITORY)
    && run.head_repository?.full_name === REPOSITORY
    && run.status === 'completed' && run.conclusion === 'success')
}

export function successfulRelease(runs, revision, kind) {
  return matchingReleases(runs, revision, kind)[0] ?? null
}

function workerReleaseJobs(worker, jobs) {
  if (!worker || !Number.isSafeInteger(worker.id) || worker.id <= 0
    || !['workflow_run', 'workflow_dispatch'].includes(worker.event)) {
    return { status: 'unproven', code: 'release_missing' }
  }
  if (!Array.isArray(jobs)) return { status: 'unproven', code: 'jobs_unavailable', runId: worker.id }
  const dispatch = worker.event === 'workflow_dispatch'
  const byName = name => jobs.filter(job => job?.name === name && job.run_id === worker.id
    && (!Number.isSafeInteger(worker.run_attempt) || (!dispatch && job.run_attempt === undefined) || job.run_attempt === worker.run_attempt)
    && (!sha(worker.head_sha) || (!dispatch && job.head_sha === undefined) || job.head_sha === worker.head_sha))
  const one = (name, conclusion) => {
    const matches = byName(name)
    return matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === conclusion ? matches[0] : null
  }
  const stepDone = (job, name) => {
    const matches = (Array.isArray(job?.steps) ? job.steps : []).filter(step => step?.name === name
      && step.status === 'completed' && step.conclusion === 'success')
    return matches.length === 1 ? matches[0] : null
  }
  const testJob = one('test', 'success'), checkJob = one('check', 'success')
  if (!testJob || !checkJob) return { status: 'unproven', code: 'jobs_unavailable', runId: worker.id }
  // On workflow_run after a failed Cloudflare deploy, trigger.outputs.ready is false
  // and this step is skipped; such a run never evaluated or published this revision.
  if (!stepDone(checkJob, WORKER_INPUTS_STEP)) return { status: 'unproven', code: 'publish_unproven', runId: worker.id }
  const webReady = one('web-ready', 'success')
  const validate = one('release / validate / build', 'success')
  const templates = one('release / templates', 'success')
  if (webReady && validate && templates) {
    const promoted = stepDone(webReady, WORKER_PROMOTED_WEB_STEP)
    const built = stepDone(validate, WORKER_VALIDATE_STEP)
    const published = stepDone(templates, WORKER_PUBLISH_STEP)
    const reported = stepDone(templates, WORKER_REPORT_STEP)
    const ordered = !Number.isSafeInteger(published?.number) || !Number.isSafeInteger(reported?.number) || published.number < reported.number
    if (!promoted || !built || !published || !reported || !ordered || !Number.isSafeInteger(validate.id) || validate.id <= 0
      || !Number.isSafeInteger(templates.id) || templates.id <= 0) {
      return { status: 'unproven', code: 'publish_unproven', runId: worker.id }
    }
    return { status: 'published', runId: worker.id, validateJobId: validate.id, publishJobId: templates.id }
  }
  const skippedWebReady = one('web-ready', 'skipped'), skippedRelease = one('release', 'skipped')
  const hasNested = jobs.some(job => job?.run_id === worker.id && typeof job.name === 'string' && job.name.startsWith('release / '))
  if (skippedWebReady && skippedRelease && !hasNested) {
    // Skipped release jobs occur for both unchanged worker inputs and retry suppression
    // of previously failed worker inputs (scripts/e2b/runtime-inputs.mjs); never treat as proven.
    return { status: 'not_published', code: 'publish_skipped', runId: worker.id }
  }
  return { status: 'unproven', code: 'publish_unproven', runId: worker.id }
}

/** Verify that an E2B additive runtime release run actually published templates for
 * worker.head_sha. workflow_run enforces record.product === GITHUB_SHA in web-ready
 * (scripts/release/cloudflare-promoted-web.mjs); workflow_dispatch may publish an
 * earlier served commit and therefore requires the verified release report artifact. */
export function workerReleaseProof(worker, jobs, { report } = {}) {
  const checked = workerReleaseJobs(worker, jobs)
  if (checked.status !== 'published') return checked
  if (worker.event === 'workflow_dispatch' || report !== undefined) {
    if (!report || !Number.isSafeInteger(worker.run_attempt) || worker.run_attempt <= 0 || !sha(worker.head_sha)) {
      return { status: 'unproven', code: 'publish_unproven', runId: worker.id }
    }
    try {
      assertReportIdentity(report, { sourceCommit: worker.head_sha, workerSha: report?.workerSha,
        runId: String(worker.id), runAttempt: String(worker.run_attempt) })
    } catch {
      return { status: 'unproven', code: 'publish_unproven', runId: worker.id }
    }
    if (!TEMPLATE_KINDS.every(kind => report.templates?.[kind]?.public === true && report.templates?.[kind]?.buildStatus === 'ready')) {
      return { status: 'unproven', code: 'publish_unproven', runId: worker.id }
    }
  }
  return checked
}

async function readPublishedReleaseReport(worker, { readGithub, token, fetchImpl, now }) {
  if (worker?.event !== 'workflow_dispatch' || !Number.isSafeInteger(worker.id) || worker.id <= 0
    || !Number.isSafeInteger(worker.run_attempt) || worker.run_attempt <= 0 || !sha(worker.head_sha)) return null
  const validRun = run => run?.id === worker.id && run.run_attempt === worker.run_attempt
    && run.head_sha === worker.head_sha && run.event === 'workflow_dispatch'
    && run.path === WORKER_RELEASE_PATH && run.name === WORKER_RELEASE_NAME && run.head_branch === 'main'
    && run.status === 'completed' && run.conclusion === 'success'
    && run.repository?.id === PUBLIC_REPOSITORY_ID && run.head_repository?.id === PUBLIC_REPOSITORY_ID
    && run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY
  try {
    const latest = await readGithub('/actions/runs/' + worker.id)
    if (!validRun(latest)) return null
    const expected = { sourceCommit: worker.head_sha, runId: worker.id, runAttempt: worker.run_attempt,
      repositoryId: PUBLIC_REPOSITORY_ID, repositoryFullName: REPOSITORY }
    const artifact = await readReleaseArtifact(expected, latest, { read: readGithub, now })
    const bytes = await downloadReleaseReport({ selected: true, artifact }, { token, fetchImpl })
    const report = JSON.parse(bytes)
    const after = await readGithub('/actions/runs/' + worker.id)
    if (!validRun(after)) return null
    return report
  } catch {
    return null
  }
}

export async function verifyWorkerReleaseCandidate(candidate, jobs, { readGithub, token, fetchImpl, now }) {
  const checked = workerReleaseJobs(candidate, jobs)
  if (checked.status !== 'published' || candidate.event !== 'workflow_dispatch') {
    return workerReleaseProof(candidate, jobs)
  }
  const report = await readPublishedReleaseReport(candidate, { readGithub, token, fetchImpl, now })
  return workerReleaseProof(candidate, jobs, { report })
}

/** Runs before the Infisical action, with no smoke-account environment access. */
export async function attestDeployment({
  env = process.env, event, fetchImpl = fetch, wait = delay, now = Date.now,
  workerHash = runtimeInputsDigest, latestPublished = lastPublishedRelease,
} = {}) {
  const guard = triggerGuard(env, event)
  check(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'configuration_required')
  async function read(url, github = false) {
    let response
    try {
      response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { accept: 'application/json', 'cache-control': 'no-store', ...(github ? { authorization: 'Bearer ' + env.GH_TOKEN } : {}) } })
    } catch { throw new AcceptanceError('deployment_proof') }
    check(response.ok, 'deployment_proof')
    const body = await response.json().catch(() => null)
    check(body !== null, 'deployment_proof')
    return body
  }
  const readGithub = path => read('https://api.github.com/repos/' + REPOSITORY + path, true)
  const sameRelease = releaseVersionGuard(guard.revision)
  const pin = async () => check(sameRelease(await read(ORIGIN + '/mikka/api/version')), 'build_mismatch')
  const runs = async workflow => readGithub('/actions/workflows/' + workflow + '/runs?head_sha=' + guard.revision + '&per_page=100')
  const runJobs = async candidate => readGithub(candidate.event === 'workflow_dispatch'
    && Number.isSafeInteger(candidate.run_attempt) && candidate.run_attempt > 0
    ? '/actions/runs/' + candidate.id + '/attempts/' + candidate.run_attempt + '/jobs?per_page=100'
    : '/actions/runs/' + candidate.id + '/jobs?filter=latest&per_page=100')
  await pin()
  const deadline = now() + (guard.mode === 'active' ? 900000 : 0)
  let worker, proof
  do {
    await pin()
    const candidates = matchingReleases((await runs('e2b-official-runtime.yml')).workflow_runs, guard.revision, 'worker')
    let skipped = null
    for (const candidate of candidates) {
      const evaluated = await verifyWorkerReleaseCandidate(candidate, (await runJobs(candidate)).jobs,
        { readGithub, token: env.GH_TOKEN, fetchImpl, now })
      if (evaluated.status === 'published') {
        worker = candidate; proof = evaluated; break
      }
      if (evaluated.status === 'not_published' && !skipped) skipped = { candidate, evaluated }
    }
    if (!worker && skipped) {
      // Skipped release jobs cover both genuinely unchanged inputs and retry suppression of
      // previously failed inputs. Accept reuse only when the latest verified published release
      // has the exact canonical worker hash of guard.revision.
      let expectedHash = null, published = null
      try { expectedHash = workerHash({ ref: guard.revision }) } catch { expectedHash = null }
      if (sha(expectedHash)) {
        try { published = await latestPublished({ token: env.GH_TOKEN, fetchImpl, now }) } catch { published = null }
      }
      if (published && sha(published.sourceCommit) && published.workerSha === expectedHash
        && Number.isSafeInteger(published.runId) && published.runId > 0) {
        worker = { id: published.runId }
        proof = { status: 'reused', runId: published.runId, sourceCommit: published.sourceCommit }
      }
    }
    if (worker || now() >= deadline) break
    await wait(30000)
  } while (!worker && now() <= deadline)
  check(worker, 'worker_release')
  await pin()
  return { status: 'ready', issue: 1245, repository: REPOSITORY, ...guard,
    workerReleaseRunId: worker.id, workerReleaseSha: guard.revision, workerReleaseStatus: proof.status,
    ...(proof.sourceCommit ? { workerReleaseSourceCommit: proof.sourceCommit } : {}),
    checkedAt: new Date(now()).toISOString() }
}

const ACTION_PAGES = ['/en', '/en?section=projects', '/en/settings?section=models']

/** Only actions this deployment's web UI publishes, named as its RPC registry names them.
 * diagnostics.deploymentId names the release that published them. */
export async function discoverActions(request, diagnostics = {}) {
  const { refs, diagnostics: found } = await discoverRpcActions(request, { origin: ORIGIN, pages: ACTION_PAGES, actions: ACTIONS })
  Object.assign(diagnostics, found)
  return refs
}

export function actionResult(data, name) {
  check(Object.hasOwn(ACTIONS, name), 'action_not_allowed')
  const { result, failure } = rpcResult(data)
  check(!failure && result !== undefined && !result?.error, 'action_refused')
  return result
}

/** Never return decision reason, title, summary, option descriptions or source contents. */
export function decisionProof(decision, scope) {
  const { projectId, workspaceId, issueId, botId, ownerId, runId, model, harness, kind, selectedOptionId, predecessorId, directionToken } = scope
  check(uuid(decision?.id) && decision.projectId === projectId && decision.workspaceId === workspaceId
    && decision.issueId === issueId && decision.ownerId === ownerId && decision.kind === kind, 'decision_scope', 'failed')
  const actor = decision.recordedBy
  const bot = scope.actor === 'bot'
  check(actor?.kind === (bot ? 'bot' : 'agent') && actor.id === (bot ? botId : runId)
    && actor.userId === ownerId && actor.botId === botId && actor.runId === (bot ? null : runId)
    && actor.identityAssurance === (bot ? 'host_context' : 'run_token')
    && (bot ? decision.runId === null : decision.runId === runId), 'decision_actor', 'failed')
  check(actor.modelId === model && actor.harness === harness, 'decision_model', 'failed')
  check(decision.captureMode === 'live' && decision.provenance === 'recorded' && decision.recordStatus === 'active'
    && typeof decision.reason === 'string' && decision.reason.trim().length > 0, 'decision_capture', 'failed')
  const sourceType = bot ? 'issue' : 'run', sourceId = bot ? issueId : runId
  check(Array.isArray(decision.sources) && decision.sources.some(source => uuid(source.sourceRef)
    && source.role === 'evidence' && source.locator?.type === sourceType && source.locator.id === sourceId),
  'decision_source', 'failed')
  if (selectedOptionId) {
    check(decision.selectedOptionId === selectedOptionId && Array.isArray(decision.options)
      && decision.options.filter(option => option.disposition === 'selected').length === 1
      && decision.options.some(option => option.id === selectedOptionId && option.disposition === 'selected')
      && decision.options.some(option => ['rejected', 'abandoned'].includes(option.disposition)
        && typeof option.reason === 'string' && option.reason.trim()), 'decision_options', 'failed')
  }
  if (predecessorId) check(decision.predecessorDecisionIds?.includes(predecessorId), 'decision_direction', 'failed')
  if (directionToken) check((decision.reason + ' ' + decision.summary).includes(directionToken), 'decision_direction', 'failed')
  return { id: decision.id, kind, captureMode: 'live', actor: bot ? 'bot' : 'agent', identityAssurance: actor.identityAssurance,
    model, harness, source: { type: sourceType, id: sourceId }, sourceCount: decision.sources.length,
    ...(selectedOptionId ? { selectedOptionId } : {}), ...(predecessorId ? { predecessorId } : {}) }
}
export async function smallArtifactBytes(response) {
  check(response.ok && response.body, 'artifact_missing', 'failed')
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      check(size <= 4096, 'artifact_content', 'failed')
      chunks.push(part.value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  return Buffer.concat(chunks)
}
const oneDecision = (rows, title) => {
  const found = rows.filter(row => row.title === title)
  check(found.length <= 1, 'decision_duplicate', 'failed')
  return found[0]
}
const selectedMenu = (menu, item) => menu?.current?.modelId === item.model
  && menu.current.kind === (item.kind === 'subscription' ? 'subscription' : 'apiKey')
  && menu.current.available === true && !menu.current.fallback

export function buildTaskPrompt({ marker, projectId, workspaceId, issueId, item, botRecord }) {
  const baseline = { kind: 'choose', title: marker + ' choose', summary: 'Choose the initial synthetic route.',
    reason: 'The baseline is the initial owner-authorized route.', options: [
      { id: 'baseline', title: 'Initial route', disposition: 'selected' },
      { id: 'alternative', title: 'Other initial route', disposition: 'rejected', reason: 'Not the requested initial route.' },
    ], selectedOptionId: 'baseline', idempotencyKey: marker + ':choose' }
  const bot = { projectId, workspaceId, issueId, kind: 'confirm', title: marker + ' bot',
    summary: 'Confirm the bounded internal acceptance task.', reason: 'The owner requested this synthetic Mikka-only task.',
    sources: [{ role: 'evidence', source: { type: 'issue', id: issueId } }], idempotencyKey: marker + ':bot' }
  return [
    'This is an authorized internal Mikka acceptance task. Use only existing issue ' + issueId + ' in project ' + projectId
      + ', workspace ' + workspaceId + '. Do not create a second issue or task.',
    botRecord ? 'Before dispatch, call record_decision exactly once in this Bot context with: ' + JSON.stringify(bot) + '. Do not record the worker decisions yourself.' : '',
    'Dispatch exactly one Factory task with dispatch_bot_computer for that existing issue, without a repository.',
    'Explicitly select my own ' + (item.kind === 'subscription' ? 'official subscription' : 'API key') + ' model ' + item.model
      + ' and harness ' + item.harness + '. No other account, model, provider or fallback is authorized.',
    'Give the worker this complete instruction: first call the real Mikka MCP record_decision tool with '
      + JSON.stringify(baseline) + '. Omit projectId, workspaceId and issueId in this worker call so the server must resolve the run issue through its actual project association.',
    item.kind === 'subscription'
      ? 'After recording the initial decision, remain working for a live owner direction change: run one local sleep of 90 seconds, then process the new owner message before finishing. If it has not arrived, wait at most another 90 seconds. Do not invent the future direction or record a redirect before the owner sends it. The new message will specify the exact final artifact.'
      : 'Then submit one markdown Artifact named ' + marker + '.md with exact UTF-8 content ' + JSON.stringify('project-decisions:' + marker + '\nroute=baseline\n') + '.',
    'Use normal Artifact submission and independent Factory review and verify. Do not create, clone, read or write a code repository, store conversations in files, send external messages, or operate on any other task. No additional paid task or retry after a provider refusal.',
  ].filter(Boolean).join('\n')
}

export async function runProjectDecisionsAcceptance({ env = process.env, event, attestation, fetchImpl = fetch, wait = delay, now = Date.now, newId = randomUUID } = {}) {
  const guard = triggerGuard(env, event)
  check(attestation?.status === 'ready' && attestation.repository === REPOSITORY && attestation.issue === 1245
    && attestation.revision === guard.revision && attestation.mode === guard.mode && attestation.workerReleaseSha === guard.revision
    && Number.isSafeInteger(attestation.workerReleaseRunId) && attestation.workerReleaseRunId > 0
    && Number.isFinite(Date.parse(attestation.checkedAt)) && now() - Date.parse(attestation.checkedAt) >= 0
    && now() - Date.parse(attestation.checkedAt) < 3600000, 'attestation_required')
  check(!env.MIKKA_ACCEPTANCE_BASE_URL || env.MIKKA_ACCEPTANCE_BASE_URL === ORIGIN + '/mikka', 'origin_rejected')
  // Account values are deliberately read only after all trigger and deployment attestation guards.
  const email = env.SMOKE_OWNER_EMAIL, password = env.SMOKE_OWNER_PASSWORD
  check(isSmokeAccountEmail(email) && typeof password === 'string' && password.length > 0, 'account_required')
  const report = { issue: 1245, revision: guard.revision, mode: guard.mode, status: 'running',
    workerReleaseRunId: attestation.workerReleaseRunId,
    startedAt: new Date(now()).toISOString(), cases: [], botRecord: null }
  let cookie = '', ownerId, workspaceId, refs = {}, safeWorkspace = true, deploymentId = ''
  async function request(path, body, method = body === undefined ? 'GET' : 'POST', extra = {}) {
    const url = new URL(path.startsWith('/mikka/') ? path : '/mikka' + path, ORIGIN)
    check(url.origin === ORIGIN && url.pathname.startsWith('/mikka/') && !url.username && !url.password, 'origin_rejected')
    try {
      return await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { origin: ORIGIN, 'cache-control': 'no-store', ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...releaseHeaders(url.pathname, deploymentId), ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch { throw new AcceptanceError('request_failed') }
  }
  async function json(path, body, method) {
    const response = await request(path, body, method)
    const value = await response.json().catch(() => null)
    check(response.ok && value !== null && !value?.error, 'http_refused', 'blocked', { httpStatus: response.status })
    return value
  }
  const sameRelease = releaseVersionGuard(guard.revision)
  const pin = async () => check(sameRelease(await json('/api/version')), 'build_mismatch')
  async function action(name, args) {
    check(Object.hasOwn(ACTIONS, name), 'action_not_allowed')
    check(refs[name] === ACTIONS[name], 'action_missing')
    const response = await request('/api/rpc', rpcBody(refs[name], args), 'POST', RPC_HEADERS)
    check(response.ok, 'action_refused', 'blocked', { httpStatus: response.status })
    return actionResult(await response.json().catch(() => null), name)
  }
  const readOrder = () => json('/api/settings/model-order?workspace=' + workspaceId)
  async function installOrder(current, wanted, remember) {
    async function mutate(change) {
      await pin()
      check(orderFingerprint(await readOrder()) === orderFingerprint(current), 'order_restore_conflict')
      current = await action('changeModelOrder', [change, workspaceId])
      remember(current)
    }
    const key = entry => JSON.stringify([entry.harness, entry.model, entry.source])
    for (const entry of current.entries) if (!wanted.some(next => key(next) === key(entry))) await mutate({ kind: 'remove', id: entry.id })
    for (const entry of wanted) if (!current.entries.some(next => key(next) === key(entry)))
      await mutate({ kind: 'add', entries: [{ harness: entry.harness, model: entry.model, source: entry.source }] })
    const ids = wanted.map(entry => current.entries.find(next => key(next) === key(entry))?.id)
    check(ids.every(id => typeof id === 'string') && ids.length === current.entries.length, 'order_changed')
    if (JSON.stringify(ids) !== JSON.stringify(current.entries.map(entry => entry.id))) await mutate({ kind: 'reorder', ids })
    return current
  }

  async function runCase(item) {
    const result = { case: item.id, model: item.model, harness: item.harness, credentialType: item.kind, status: 'running',
      cleanup: { state: 'not_created', orderRestored: true } }
    const marker = '1245-' + guard.revision.slice(0, 12) + '-' + item.id
    let project, issue, bot, state, runId, originalOrder, testOrder, orderTouched = false, directionToken, initial, redirected
    const runIds = new Set()
    const scope = () => ({ projectId: project.id, workspaceId, issueId: issue.id, botId: bot.id, ownerId,
      runId, model: item.model, harness: item.harness })
    const decisions = async () => {
      const data = await json('/api/projects/' + project.id + '/decisions?workspaceId=' + workspaceId)
      check(data.projectId === project.id && data.workspaceId === workspaceId && Array.isArray(data.decisions), 'decision_scope', 'failed')
      return data.decisions
    }
    async function task() {
      const list = await json('/api/factory/tasks?issueId=' + issue.id)
      check(list.issueId === issue.id && Array.isArray(list.tasks) && list.tasks.length <= 1, 'task_scope', 'failed')
      if (!list.tasks.length) return null
      check(uuid(list.tasks[0].id), 'task_scope', 'failed')
      const value = await json('/api/factory/tasks/' + list.tasks[0].id)
      check(value.task?.id === list.tasks[0].id && value.task.issueId === issue.id && value.task.botId === bot.id
        && value.task.userId === ownerId, 'task_scope', 'failed')
      for (const attempt of value.attempts ?? []) if (uuid(attempt.runId)) runIds.add(attempt.runId)
      result.taskId = value.task.id
      return value
    }
    async function proof(id) {
      const value = await json('/api/runs/' + id + '/evidence')
      const p = assertRunEvidence(value, { ...scope(), kind: item.kind, keyId: source?.source?.keyId })
      check(p.runId === id, 'run_scope', 'failed')
      runIds.add(id)
      return { value, proof: p }
    }
    let source
    try {
      check(safeWorkspace, 'cleanup_incomplete')
      await pin()
      check(Object.keys(ACTIONS).every(name => refs[name]), 'action_missing')
      originalOrder = await readOrder()
      const keys = item.kind === 'api_key' ? await json('/api/settings/api-keys?workspace=' + workspaceId) : { keys: [] }
      source = ownedSource(item, { order: originalOrder, keys, connections: await json('/api/subscriptions?workspace=' + workspaceId), ownerId })
      const plan = caseOrderPlan(originalOrder, [source], ownerId)
      await assertWorkspaceIdle(json)
      const menu = await json('/api/mobile/model')
      const options = (menu.groups ?? []).filter(group => group.kind === (item.kind === 'subscription' ? 'subscription' : 'apiKey'))
        .flatMap(group => group.options ?? []).filter(option => option.modelId === item.model
          && option.provider === item.provider && (item.kind !== 'api_key' || option.id === 'apikey:' + source.source.keyId + ':' + item.model))
      check(options.length === 1, options.length ? 'source_ambiguous' : 'source_missing')
      result.preflight = { ownSource: true, cloudReady: true, structureActions: true, fixedModel: true }
      if (guard.mode === 'preflight') { result.status = 'ready'; return result }
      const existing = await action('listProjects', [])
      check(Array.isArray(existing), 'response_invalid')
      check(!existing.some(value => value.name === marker), 'previous_fixture')
      project = (await action('saveProject', [{ name: marker, summary: 'Internal synthetic project decision acceptance',
        description: '', status: 'started', priority: 'low', lead: 'me', team: 'Mikka', startDate: '', targetDate: '',
        properties: { color: 'gray', members: [], labels: [], dependencyIds: [], milestones: [] } }])).project
      check(uuid(project?.id) && project.userId === ownerId && project.name === marker && project.issueIds?.length === 0, 'project_scope', 'failed')
      result.projectId = project.id
      result.cleanup = { state: 'evidence_retained', orderRestored: true, projectRetained: true }
      issue = (await action('saveIssue', [{ title: marker, content: { type: 'doc', content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'Authorized disposable Mikka-only decision acceptance. No repository or external actions.' }] }] }, status: 'todo', priority: 'low' }])).issue
      check(uuid(issue?.id) && issue.userId === ownerId && issue.title === marker && issue.scope === 'personal'
        && issue.linearTargetVerified !== true, 'issue_scope', 'failed')
      result.issueId = issue.id
      await action('setProjectIssues', [{ id: project.id, revision: project.revision, issueIds: [issue.id] }])
      const linked = await action('listProjects', [])
      check(Array.isArray(linked) && linked.filter(value => value.issueIds?.includes(issue.id)).length === 1
        && linked.some(value => value.id === project.id && value.userId === ownerId && value.issueIds.length === 1 && value.issueIds[0] === issue.id),
      'structure_missing', 'failed')
      check((await decisions()).length === 0, 'previous_fixture')
      bot = await json('/api/bots', { name: marker })
      check(uuid(bot?.id) && bot.ownerId === ownerId && bot.workspaceId === workspaceId, 'bot_scope', 'failed')
      result.botId = bot.id
      result.cleanup.botRetained = true
      const botMenu = await json('/api/mobile/model?bot=' + bot.id)
      check((botMenu.groups ?? []).some(group => group.kind === (item.kind === 'subscription' ? 'subscription' : 'apiKey')
        && group.options?.some(option => option.id === options[0].id && option.modelId === item.model)), 'model_selection')
      check(selectedMenu(await json('/api/mobile/model', { bot: bot.id, id: options[0].id }, 'PUT'), item), 'model_selection')
      testOrder = originalOrder
      if (!plan.already) {
        orderTouched = true; result.cleanup.orderRestored = false
        testOrder = await installOrder(originalOrder, [source], value => { testOrder = value })
      }
      check(selectedMenu(await json('/api/mobile/model?bot=' + bot.id), item), 'model_changed')
      const botRecord = item.kind === 'subscription' && !report.botRecord
      const prompt = buildTaskPrompt({ marker, projectId: project.id, workspaceId, issueId: issue.id, item, botRecord })
      if (item.kind === 'api_key') assertFlashTestModel(item.model)
      await pin()
      const submitted = await request('/api/agents/eve/v1/session?botId=' + bot.id, { message: prompt, clientContext: { expectedOwnerId: ownerId, expectedWorkspaceId: workspaceId } }, 'POST', { 'x-mikka-submission-id': deterministicId(marker) })
      const receipt = await submitted.json().catch(() => null)
      check(submitted.status === 202, 'http_refused', 'blocked', { httpStatus: submitted.status })
      check(receipt?.ok === true && /^wrun_[A-Za-z0-9_-]+$/.test(receipt.sessionId ?? '')
        && typeof receipt.deliveryId === 'string' && receipt.deliveryId.length > 0, 'response_invalid')
      const deadline = now() + 600000
      while (now() < deadline) {
        await pin()
        check(orderFingerprint(await readOrder()) === orderFingerprint(testOrder), 'order_changed')
        state = await task()
        const rows = await decisions()
        if (botRecord) {
          const recorded = oneDecision(rows, marker + ' bot')
          if (recorded) report.botRecord = { projectId: project.id, botId: bot.id, ...decisionProof(recorded, { ...scope(), actor: 'bot', kind: 'confirm' }) }
        }
        if (state) {
          const execute = state.attempts?.find(attempt => attempt.stage === 'execute' && uuid(attempt.runId))
          if (execute) {
            if (runId) check(runId === execute.runId, 'run_scope', 'failed')
            runId = execute.runId; result.runId = runId
            const current = await proof(runId)
            result.execution = current.proof
            const detail = await action('getIssueThread', [issue.id, runId])
            const receipt = providerReceipt(detail)
            if (receipt) throw new AcceptanceError('provider_refused', 'blocked', { providerKind: receipt.kind, providerStatus: receipt.status })
            check(!(detail.thread?.modelFallback ?? []).some(value => value.state === 'switched'), 'model_changed', 'failed')
            const chosen = oneDecision(rows, marker + ' choose')
            if (chosen) { initial = decisionProof(chosen, { ...scope(), kind: 'choose', selectedOptionId: 'baseline' }); result.decisions = [initial] }
            if (initial && item.kind === 'subscription' && !directionToken) {
              const live = await json('/api/mobile/threads/' + runId)
              check(live.working === true, 'mid_run_window_missed')
              directionToken = newId()
              check(uuid(directionToken), 'configuration_required')
              const finalContent = 'project-decisions:' + marker + '\nroute=revised\n' + directionToken + '\n'
              const followup = 'Change direction now. Abandon baseline and select revised. Call the real record_decision tool once with '
                + JSON.stringify({ kind: 'redirect', title: marker + ' redirect', summary: 'Direction token ' + directionToken,
                  reason: 'The owner changed the requested route while this run was working. Direction token ' + directionToken,
                  contextOptionRef: { decisionId: initial.id, optionId: initial.selectedOptionId },
                  options: [{ id: 'baseline', title: 'Initial route', disposition: 'abandoned', reason: 'Superseded by the live owner direction.',
                    derivedFrom: { decisionId: initial.id, optionId: initial.selectedOptionId } },
                    { id: 'revised', title: 'Revised route', disposition: 'selected' }], selectedOptionId: 'revised',
                  predecessorDecisionIds: [initial.id], idempotencyKey: marker + ':redirect' })
                + '. Continue on this same run and actual project association. Then submit one markdown Artifact named ' + marker + '.md with exact UTF-8 content '
                + JSON.stringify(finalContent) + '. Do not create another issue/task or record through the human HTTP endpoint.'
              await pin()
              const queued = await request('/api/mobile/threads/' + runId, { text: followup })
              const acknowledged = await queued.json().catch(() => null)
              check(queued.status === 202 && acknowledged?.queued === true, 'steer_not_queued')
              result.midRun = { runId, observedWorking: true, queued: true, sentAt: new Date(now()).toISOString() }
            }
            const changed = oneDecision(rows, marker + ' redirect')
            if (changed) {
              check(directionToken && initial, 'decision_direction', 'failed')
              redirected = decisionProof(changed, { ...scope(), kind: 'redirect', selectedOptionId: 'revised',
                predecessorId: initial.id, directionToken })
              result.decisions = [initial, redirected]
            }
            const candidate = state.candidates?.find(value => value.id === state.task.candidateId)
            const checks = (state.attempts ?? []).filter(attempt => attempt.candidateId === candidate?.id && attempt.status === 'passed')
            if (initial && (item.kind === 'api_key' || redirected) && current.value.run.status === 'succeeded'
              && candidate?.runId === runId && ['review', 'verify'].every(stage => checks.some(attempt => attempt.stage === stage))) {
              if (botRecord) check(report.botRecord?.projectId === project.id, 'bot_decision_missing')
              const checkAttempts = ['review', 'verify'].map(stage => checks.findLast(attempt => attempt.stage === stage))
              check(new Set([runId, ...checkAttempts.map(attempt => attempt.runId)]).size === 3
                && checkAttempts.every(attempt => attempt.output?.requestEpoch === state.task.sourceEventId), 'checks_missing', 'failed')
              result.checks = await verifyCheckRuns(checkAttempts, { ...scope(), kind: item.kind, keyId: source.source.keyId },
                async id => (await proof(id)).value)
              const artifacts = (current.value.artifacts ?? []).filter(value => value.title === marker + '.md')
              check(artifacts.length === 1 && uuid(artifacts[0].id), 'artifact_missing', 'failed')
              const artifact = artifacts[0]
              check(new RegExp('^/mikka/api/artifacts/' + artifact.id + '/versions/[1-9][0-9]*/download$').test(artifact.url), 'artifact_scope', 'failed')
              const response = await request(artifact.url)
              check(response.ok, 'artifact_missing', 'failed')
              const bytes = await smallArtifactBytes(response)
              const expected = 'project-decisions:' + marker + '\nroute=' + (item.kind === 'api_key' ? 'baseline\n' : 'revised\n' + directionToken + '\n')
              check(bytes.length <= 4096 && bytes.equals(Buffer.from(expected, 'utf8')), 'artifact_content', 'failed')
              result.artifact = { id: artifact.id, bytes: bytes.length, sha256: digest(bytes) }
              result.decisions = [initial, ...(redirected ? [redirected] : [])]
              result.status = 'pass'
              break
            }
            if (terminalRuns.has(current.value.run.status) && current.value.run.status !== 'succeeded')
              throw new AcceptanceError('task_blocked')
          }
          if (['failed', 'blocked', 'cancelled', 'revoked'].includes(state.task.status)) throw new AcceptanceError('task_blocked')
        }
        const chat = await readChatState(request, bot.id)
        if (!state && !chat.working && chat.failed) throw new AcceptanceError('provider_refused')
        await wait(3000)
      }
      check(result.status === 'pass', 'task_timeout')
    } catch (error) { Object.assign(result, publicFailure(error)) }
    finally {
      if (bot) {
        try {
          // Only this newly-created Bot's owner-bound work is stopped, including an accidental extra dispatch.
          // Retain evidence; no project/Bot deletion API or database mutation is invented.
          const cleanupIssues = new Set([issue.id]), cleanupTaskIds = new Set()
          const cleanupDeadline = now() + 90000
          let stable = 0, previous = ''
          while (now() < cleanupDeadline && stable < 2) {
            await json('/api/mobile/chat/stop', { botId: bot.id })
            const page = await json('/api/mobile/bots/' + bot.id)
            check(Array.isArray(page.threads) && page.threads.length <= 30, 'cleanup_incomplete', 'failed')
            for (const thread of page.threads) {
              check(uuid(thread.id), 'run_scope', 'failed')
              runIds.add(thread.id)
            }
            for (const id of runIds) {
              const found = await json('/api/runs/' + id + '/evidence')
              const identity = found.run?.executionIdentity
              check(found.run?.id === id && found.run.botId === bot.id && uuid(found.run.issueId)
                && identity?.requester === ownerId && identity.executionPrincipal === ownerId
                && identity.botId === bot.id && identity.botOwner === ownerId && identity.workspaceId === workspaceId,
              'run_scope', 'failed')
              cleanupIssues.add(found.run.issueId)
            }
            for (const issueId of cleanupIssues) {
              const list = await json('/api/factory/tasks?issueId=' + issueId)
              check(list.issueId === issueId && Array.isArray(list.tasks) && list.tasks.length <= 20, 'cleanup_incomplete', 'failed')
              for (const summary of list.tasks) {
                check(uuid(summary.id), 'task_scope', 'failed')
                const owned = await json('/api/factory/tasks/' + summary.id)
                // An unrelated task on an issue is not owned by this new Bot and is never changed.
                if (owned.task?.botId !== bot.id) continue
                check(owned.task.id === summary.id && owned.task.issueId === issueId && owned.task.userId === ownerId, 'task_scope', 'failed')
                cleanupTaskIds.add(owned.task.id)
                for (const attempt of owned.attempts ?? []) if (uuid(attempt.runId)) runIds.add(attempt.runId)
                if (!terminalTasks.has(owned.task.status)) {
                  const response = await request('/api/factory/tasks/' + owned.task.id, {
                    binding: { taskId: owned.task.id, revision: owned.task.revision },
                    eventId: deterministicId(marker + ':cancel:' + owned.task.id + ':' + owned.task.revision),
                    action: 'cancel', reason: 'Bounded project decision acceptance completed.',
                  })
                  check(response.ok || response.status === 409, 'cleanup_incomplete', 'failed')
                }
              }
            }
            for (const id of runIds) {
              const found = await json('/api/runs/' + id + '/evidence')
              check(found.run?.botId === bot.id && cleanupIssues.has(found.run.issueId)
                && found.run.executionIdentity?.requester === ownerId && found.run.executionIdentity?.workspaceId === workspaceId,
              'run_scope', 'failed')
              const response = await request('/api/mobile/threads/' + id + '/stop', {})
              const value = await response.json().catch(() => null)
              check(response.ok || (response.status === 409 && value?.error === 'runChainEnded'), 'cleanup_incomplete', 'failed')
            }
            const chat = await readChatState(request, bot.id)
            const tasks = await Promise.all([...cleanupTaskIds].map(id => json('/api/factory/tasks/' + id)))
            const statuses = await Promise.all([...runIds].map(id => json('/api/runs/' + id + '/evidence')))
            const signature = [...cleanupTaskIds, ...runIds].sort().join(',')
            const stopped = !chat.working && !chat.streamRunId && tasks.every(value => terminalTasks.has(value.task?.status))
              && statuses.every(value => terminalRuns.has(value.run?.status))
            stable = stopped && previous === signature ? stable + 1 : 0
            previous = signature
            if (stable < 2) await wait(3000)
          }
          check(stable >= 2, 'cleanup_incomplete', 'failed')
          result.cleanup.state = 'stopped_evidence_retained'
        } catch (error) {
          result.cleanup.state = 'incomplete'; result.cleanup.failure = publicFailure(error)
          safeWorkspace = false; result.status = 'failed'; result.code = 'cleanup_incomplete'
        }
      }
      if (orderTouched) {
        try {
          check(safeWorkspace && testOrder, 'cleanup_incomplete', 'failed')
          await assertWorkspaceIdle(json)
          check(orderFingerprint(await readOrder()) === orderFingerprint(testOrder), 'order_restore_conflict')
          const restored = await installOrder(testOrder, originalOrder.entries, value => { testOrder = value })
          check(JSON.stringify(restored.entries.map(value => [value.harness, value.model, value.source]))
            === JSON.stringify(originalOrder.entries.map(value => [value.harness, value.model, value.source])), 'order_restore_conflict')
          result.cleanup.orderRestored = true
        } catch (error) {
          safeWorkspace = false; result.cleanup.failure = publicFailure(error)
          result.status = 'failed'; result.code = 'order_restore_conflict'
        }
      }
    }
    return result
  }

  try {
    await pin()
    const login = await request('/api/auth/sign-in/email', { email, password })
    check(login.ok, 'sign_in_failed')
    cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
    check(cookie.length > 0, 'session_missing')
    const session = await json('/api/auth/get-session')
    check(session?.user?.email?.toLowerCase() === email.toLowerCase() && typeof session.user.id === 'string', 'session_identity')
    ownerId = session.user.id
    const bots = await json('/api/bots')
    check(Array.isArray(bots) && bots.length > 0 && bots.every(bot => bot.ownerId === ownerId && bot.workspaceId === bots[0].workspaceId)
      && uuid(bots[0].workspaceId), 'workspace_missing')
    workspaceId = bots[0].workspaceId
    report.actionDiscovery = {}
    refs = await discoverActions(request, report.actionDiscovery)
    // Every later fixture read and write goes to the release that published these actions.
    deploymentId = report.actionDiscovery.deploymentId ?? ''
    // A refused API path does not gate or substitute either official subscription path.
    for (const item of CASES) report.cases.push(await runCase(item))
    await pin()
    const expected = guard.mode === 'preflight' ? 'ready' : 'pass'
    report.status = report.cases.every(result => result.status === expected) && (guard.mode === 'preflight' || report.botRecord)
      ? expected : 'partial'
  } catch (error) {
    Object.assign(report, publicFailure(error))
    if (!report.cases.length) report.cases = CASES.map(item => ({ case: item.id, model: item.model, ...publicFailure(error) }))
  } finally {
    if (cookie) report.sessionClosed = await request('/api/auth/sign-out', {}).then(response => response.ok).catch(() => false)
    cookie = ''
    report.finishedAt = new Date(now()).toISOString()
  }
  return report
}

async function output(name, report) {
  await mkdir('project-decisions-report', { recursive: true })
  await writeFile('project-decisions-report/' + name + '.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  const summary = ['## Project decisions acceptance', '', 'Application: ' + (report.revision ?? 'unavailable'),
    'Result: ' + report.status, '', '| Path | Result | Code |', '| --- | --- | --- |',
    ...(report.cases ?? []).map(item => '| ' + item.case + ' | ' + item.status + ' | ' + (item.code ?? '') + ' |'),
    ...(report.actionDiscovery?.required ? ['',
      'Actions found: ' + (report.actionDiscovery.found.join(', ') || 'none'),
      'Actions missing: ' + (report.actionDiscovery.missing.join(', ') || 'none'),
      'Public pages read/failed: ' + report.actionDiscovery.pagesRead + '/' + report.actionDiscovery.pagesFailed,
      'Public action lists read/failed: ' + report.actionDiscovery.manifestsRead + '/' + report.actionDiscovery.manifestsFailed] : []),
    '', 'Only fixed metadata, IDs and hashes are reported. A blocked path is not a pass.',
    'Synthetic project, Bot and decision evidence is retained; owned live work is stopped.', ''].join('\n')
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
  console.log(summary)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const attesting = process.argv.includes('--attest')
  let report
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    report = attesting ? await attestDeployment({ event }) : await runProjectDecisionsAcceptance({
      event, attestation: JSON.parse(await readFile('project-decisions-report/attestation.json', 'utf8')),
    })
  } catch (error) { report = { issue: 1245, ...publicFailure(error) } }
  await output(attesting ? 'attestation' : 'report', report)
  if (attesting && report.status === 'ready' && process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'ready=true\n')
  if (!['pass', 'ready'].includes(report.status)) process.exitCode = 1
}
