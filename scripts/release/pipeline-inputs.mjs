import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateHistoricalReleaseManifest, validateReleaseManifest } from './service-builds.mjs'
import { actionsMikkaRepository, officialMikkaRepository, operationsRepositoryId, publicRepositoryId } from '../cloudflare-source.mjs'
import { checkedReleasePolicy, policyFromContents, POLICY_PATH, requireCommittedPromoters, requirePromoters } from './release-policy.mjs'
import { runReleaseChecks } from './release-checks.mjs'

const trustedActors = { owner: { id: '183887963', login: 'alexj11324' }, mergeQueue: { id: '118344674', login: 'github-merge-queue[bot]' } }
const trustedActor = (actor, automatic) => String(actor?.id) === trustedActors.owner.id
  || (automatic && String(actor?.id) === trustedActors.mergeQueue.id && actor?.login === trustedActors.mergeQueue.login)

export const repository = 'alexj11324/Mikka'
const producer = '.github/workflows/cloudflare-api-image.yml'
const deployment = '.github/workflows/cloudflare-app-deploy.yml'
const qualification = '.github/workflows/cloud-services-ci.yml'
const number = /^[1-9][0-9]{0,15}$/
const sha = /^[a-f0-9]{40}$/
const archiveDigest = /^sha256:[a-f0-9]{64}$/
const apiRoot = 'https://api.github.com/repositories/'

export function checkedRun(run, path, { event, successful = true, automaticDeployment = false } = {}) {
  for (const key of ['repository', 'head_repository']) {
    assert.ok(officialMikkaRepository(run[key]?.full_name, String(run[key]?.id)), 'pipeline_run_repository_scope')
    assert.equal(run[key].fork, false, 'pipeline_run_fork_rejected')
    assert.equal(run[key].private, false, 'pipeline_run_repository_private')
  }
  assert.equal(run.path, path, 'pipeline_run_workflow_mismatch')
  assert.equal(run.head_branch, 'main', 'pipeline_run_branch_required')
  const automatic = (path === producer && run.event === 'push') || (automaticDeployment && path === deployment && run.event === 'workflow_run')
  // Dispatch runs are gated by repository write access, not a fixed actor list.
  const dispatch = run.event === 'workflow_dispatch'
  if (!dispatch) {
    assert.ok(trustedActor(run.actor, automatic), 'pipeline_run_actor_untrusted')
    assert.ok(trustedActor(run.triggering_actor, automatic), 'pipeline_run_trigger_untrusted')
  }
  assert.match(run.head_sha ?? '', sha, 'pipeline_run_sha_required')
  assert.match(String(run.id), number, 'pipeline_run_id_required')
  assert.match(String(run.run_attempt), number, 'pipeline_run_attempt_required')
  assert.equal(run.status, 'completed', 'pipeline_run_incomplete')
  if (successful) assert.equal(run.conclusion, 'success', 'pipeline_run_unsuccessful')
  if (event) assert.equal(run.event, event, 'pipeline_run_event_mismatch')
  return run
}

/** Do not deploy an older candidate after it has waited for the deployment
 * lease. Every main push produces a manifest; the latest build's completion
 * starts its own run. Superseded runs are recorded, never counted as releases. */
export function selectAutomaticCandidate(event, actualRun, mainSha) {
  assert.ok(officialMikkaRepository(event?.repository?.full_name, String(event?.repository?.id)), 'pipeline_event_repository_scope')
  assert.equal(event.action, 'completed', 'pipeline_event_action_required')
  checkedRun(actualRun, producer, { event: 'push' })
  for (const field of ['id', 'run_attempt', 'head_sha', 'event', 'head_branch', 'status', 'conclusion'])
    assert.equal(event.workflow_run?.[field], actualRun[field], 'pipeline_event_run_mismatch')
  assert.match(mainSha ?? '', sha, 'pipeline_main_sha_required')
  return actualRun.head_sha === mainSha ? 'selected' : 'superseded'
}

const preWriteSteps = ['artifacts', 'existing-resources']

/** A completed rollback makes its previous manifest current again. A failed
 * deployment must be recovered explicitly before another automatic writer. */
export function baselineOrigin(summary, target = 'staging') {
  assert.equal(summary?.version, 1, 'pipeline_summary_version_required')
  assert.equal(summary.target, target, 'pipeline_summary_target_mismatch')
  if (summary.rollback?.status === 'passed') return summary.previousOrigin ?? null
  // The publisher reads artifacts and observes every existing resource before its first migration or
  // service write. A run that failed at one of those two steps changed nothing, so its baseline stands.
  if (summary.status === 'failed' && preWriteSteps.includes(summary.failedStep) && summary.rollback === undefined
    && summary.admission === undefined) return summary.previousOrigin ?? null
  assert.equal(summary.status, 'passed', 'pipeline_previous_release_requires_recovery')
  assert.equal(summary.verification?.status, 'pass', 'pipeline_summary_verification_required')
  return summary.origin
}

export function artifactFor(run, artifacts, prefix) {
  const expected = `${prefix}-${run.id}-${run.run_attempt}`
  const matching = artifacts.filter(artifact => artifact.name === expected && !artifact.expired)
  assert.equal(matching.length, 1, 'pipeline_original_artifact_required')
  const artifact = matching[0]
  assert.match(String(artifact.id), number, 'pipeline_artifact_id_required')
  assert.equal(artifact.workflow_run?.id, run.id, 'pipeline_artifact_run_mismatch')
  assert.equal(artifact.workflow_run?.head_sha, run.head_sha, 'pipeline_artifact_sha_mismatch')
  assert.equal(artifact.workflow_run?.head_branch, run.head_branch, 'pipeline_artifact_branch_mismatch')
  assert.equal(artifact.workflow_run?.repository_id, 1427517699, 'pipeline_artifact_repository_scope')
  assert.equal(artifact.workflow_run?.head_repository_id, 1427517699, 'pipeline_artifact_repository_scope')
  assert.match(artifact.digest ?? '', archiveDigest, 'pipeline_artifact_digest_required')
  assert.ok(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 4 * 1024 * 1024, 'pipeline_artifact_size_invalid')
  return artifact
}

export async function github(path, { token, method = 'GET', body, bytes = false } = {}) {
  assert.ok(typeof path === 'string' && !path.startsWith('/') && !path.includes('://'), 'pipeline_path_invalid')
  const prefix = path.startsWith(repository + '/') ? repository + '/' : 'alexj11324/mikka-cloud/'
  assert.ok(path.startsWith(prefix), 'pipeline_repository_scope')
  const repositoryId = prefix === repository + '/' ? publicRepositoryId : operationsRepositoryId
  token ??= repositoryId === publicRepositoryId
    ? process.env.MIKKA_PUBLIC_ACTIONS_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
    : process.env.GH_TOKEN
  assert.ok(token, 'pipeline_github_identity_required')
  let response
  try {
    response = await fetch(apiRoot + repositoryId + '/' + path.slice(prefix.length), { method, headers: {
      authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) })
  } catch { throw new Error('pipeline_github_request_failed') }
  if (!response.ok) throw Object.assign(new Error('pipeline_github_request_rejected'), { status: response.status })
  return bytes ? Buffer.from(await response.arrayBuffer()) : response.json()
}

async function pages(api, path, key) {
  const result = []
  for (let page = 1; ; page++) {
    const value = await api(`${repository}/${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    assert.ok(Array.isArray(value[key]), 'pipeline_inventory_response_invalid')
    result.push(...value[key])
    if (result.length >= value.total_count || value[key].length < 100) return result
    assert.ok(page < 100, 'pipeline_inventory_too_large')
  }
}

export function readArtifactMembers(bytes, artifact) {
  assert.equal(bytes.length, artifact.size_in_bytes, 'pipeline_artifact_size_mismatch')
  assert.equal('sha256:' + createHash('sha256').update(bytes).digest('hex'), artifact.digest, 'pipeline_artifact_digest_mismatch')
  let text
  try {
    text = execFileSync('python3', ['-c', String.raw`
import io,json,stat,sys,zipfile
allowed={'release-manifest.json','previous-manifest.json','pipeline-summary.json','receipt.json'}
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    entries=archive.infolist()
    if not 1 <= len(entries) <= 4: raise ValueError('entries')
    seen=set(); result={}; total=0
    for entry in entries:
        if entry.orig_filename not in allowed or entry.orig_filename in seen: raise ValueError('name')
        seen.add(entry.orig_filename)
        if stat.S_IFMT(entry.external_attr >> 16) not in (0,stat.S_IFREG) or entry.flag_bits & 1: raise ValueError('type')
        total += entry.file_size
        if total > 4*1024*1024: raise ValueError('size')
        result[entry.orig_filename]=json.loads(archive.read(entry))
    print(json.dumps(result))
`], { input: bytes, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch { throw new Error('pipeline_artifact_format_invalid') }
  return JSON.parse(text)
}

async function members(api, run, prefix) {
  const artifacts = await pages(api, `actions/runs/${run.id}/artifacts`, 'artifacts')
  const artifact = artifactFor(run, artifacts, prefix)
  const bytes = await api(`${repository}/actions/artifacts/${artifact.id}/zip`, { bytes: true })
  return { artifact, files: readArtifactMembers(bytes, artifact) }
}

async function releasePacket(api, runId, runAttempt) {
  assert.match(String(runId ?? ''), number, 'pipeline_release_run_required')
  const path = runAttempt ? `actions/runs/${runId}/attempts/${runAttempt}` : `actions/runs/${runId}`
  const run = checkedRun(await api(`${repository}/${path}`), producer, { event: 'push' })
  assert.equal(String(run.id), String(runId), 'pipeline_release_run_mismatch')
  if (runAttempt) assert.equal(String(run.run_attempt), String(runAttempt), 'pipeline_release_attempt_mismatch')
  const packet = await members(api, run, 'release-manifest')
  assert.deepEqual(Object.keys(packet.files), ['release-manifest.json'], 'pipeline_release_member_required')
  const manifest = packet.files['release-manifest.json']
  assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'pipeline_release_manifest_required')
  assert.equal(manifest.sourceCommit, run.head_sha, 'pipeline_release_source_mismatch')
  return { run, manifest,
    origin: { runId: String(run.id), runAttempt: String(run.run_attempt), artifactId: String(packet.artifact.id) } }
}

async function release(api, runId, runAttempt) {
  const result = await releasePacket(api, runId, runAttempt)
  validateReleaseManifest(result.manifest)
  return result
}

// Only already-published state and rollback use the historical reader. Every
// forward staging/production candidate goes through the strict v2 reader above.
async function historicalRelease(api, runId, runAttempt) {
  const result = await releasePacket(api, runId, runAttempt)
  validateHistoricalReleaseManifest(result.manifest)
  return result
}

export async function priorDeployment(api, currentRun, selectedRun, target = 'staging') {
  const runs = selectedRun ? [await api(`${repository}/actions/runs/${selectedRun}`)]
    : await pages(api, 'actions/workflows/cloudflare-app-deploy.yml/runs?branch=main', 'workflow_runs')
  // Run creation/start timestamps include time waiting for the concurrency group. Only the
  // actual Deploy-step intervals prove writer order; equal or overlapping intervals are ambiguous.
  let found, foundInterval
  for (const latest of runs) {
    const isCurrent = String(latest.id) === String(currentRun)
    if (!isCurrent && latest.status !== 'completed') continue
    assert.ok(Number.isSafeInteger(latest.run_attempt) && latest.run_attempt > 0, 'pipeline_deployment_attempt_required')
    // Re-running only failed jobs does not erase an earlier writer. Search
    // every earlier completed attempt, including this run's previous attempt.
    // A fresh selection failure must never hide a partial deployment.
    for (let attempt = latest.run_attempt - Number(isCurrent); attempt >= 1; attempt--) {
      const run = attempt === latest.run_attempt ? latest
        : await api(`${repository}/actions/runs/${latest.id}/attempts/${attempt}`)
      checkedRun(run, deployment, { successful: false, automaticDeployment: true })
      assert.equal(run.run_attempt, attempt, 'pipeline_deployment_attempt_mismatch')
      assert.ok(['workflow_run', 'workflow_dispatch'].includes(run.event), 'pipeline_deployment_event_invalid')
      attemptStart(run)
      const jobs = await pages(api, `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs')
      // A completed stage-all re-bootstraps staging onto a new reviewed
      // hosted-api-staging.json release with fresh unmarked Workers, so older
      // staging pipeline runs no longer describe the live staging baseline.
      // Production is untouched, and pipeline-release.mjs still requires every
      // live staging Worker to have no pipeline marker before allowing bootstrap.
      if (target === 'staging' && !selectedRun && run.event === 'workflow_dispatch') {
        const stageAll = jobs.find(item => item.name === 'deploy-application' && item.status === 'completed'
          && item.conclusion === 'success'
          && item.steps?.some(step => step.name === 'Deploy the reviewed public artifacts and verify the selected phase' && step.conclusion === 'success'))
        if (stageAll) {
          const log = (await api(`${repository}/actions/jobs/${stageAll.id}/logs`, { bytes: true })).toString('utf8')
          const phases = log.split(/\r?\n/).flatMap(line => {
            const match = /\bMIKKA_PUBLIC_DEPLOYMENT_PHASE=(\{.*\})\s*$/.exec(line)
            if (!match) return []
            try { return [JSON.parse(match[1])] } catch { return [] }
          })
          if (phases.length === 1 && phases[0].version === 1 && phases[0].phase === 'stage-all'
              && phases[0].status === 'completed' && phases[0].operator?.runId === String(run.id)
              && phases[0].operator?.runAttempt === String(run.run_attempt)) {
            const interval = deploymentInterval(stageAll.steps.find(step => step.name === 'Deploy the reviewed public artifacts and verify the selected phase'))
            if (found !== undefined && interval.end < foundInterval.start) break
            assert.ok(found === undefined || interval.start > foundInterval.end, 'pipeline_deployment_order_ambiguous')
            found = null
            foundInterval = interval
            break
          }
        }
      }
      const jobName = target === 'production' ? 'pipeline-production' : 'pipeline'
      const job = jobs.find(job => job.name === jobName)
      if (!job || job.conclusion === 'skipped') continue
      assert.equal(job.status, 'completed', 'pipeline_deployment_job_incomplete')
      const applied = job.steps?.find(step => step.name === (target === 'production'
        ? 'Promote and verify the staged service manifest' : 'Deploy and verify staged service manifest'))
      // A failed checkout/selection never acquired a deployment writer. Do not
      // confuse it with a partially applied release that requires rollback.
      if (!applied || applied.conclusion === 'skipped') continue
      const interval = deploymentInterval(applied)
      // Earlier attempts of this same run also precede this completed attempt. Only a strictly
      // earlier Deploy interval can avoid reading its archive; run/list order is not evidence.
      if (found !== undefined && interval.end < foundInterval.start) break
      let packet
      try {
        packet = await members(api, run, target === 'production' ? 'deploy-production' : 'deploy-pipeline')
      } catch (error) {
        // GitHub deletes a job's artifacts when that job is re-run, so a re-run of a
        // deployment whose Deploy step ran erases the receipt this gate requires.
        // Still fail closed; only name the cause and the recovery.
        if (selectionError(error) !== 'pipeline_original_artifact_required' || attempt >= latest.run_attempt) throw error
        throw new Error(isCurrent ? 'pipeline_rerun_after_deploy_refused' : 'pipeline_rerun_erased_receipt_requires_recovery')
      }
      const summary = packet.files['pipeline-summary.json']
      if (summary === undefined) {
        // The publisher writes its first receipt and summary after reading every input and resource
        // and before any migration or service write, and prints the summary on any failure that has one.
        // A Deploy step that uploaded no summary and printed none (for example a GitHub read failed while
        // authenticating the candidate) never reached a writer, so it neither blocks nor sets the baseline.
        const log = (await api(`${repository}/actions/jobs/${job.id}/logs`, { bytes: true })).toString('utf8')
        assert.ok(log.includes(`Artifact ${packet.artifact.name}.zip successfully finalized.`)
          && log.includes(`Artifact ID ${packet.artifact.id}`), 'pipeline_summary_upload_evidence_required')
        assert.ok(!log.includes('MIKKA_DEPLOYMENT_PIPELINE='), 'pipeline_deployment_summary_missing')
        continue
      }
      assert.equal(summary?.deployment?.runId, String(run.id), 'pipeline_deployment_summary_run_mismatch')
      assert.equal(summary.deployment.runAttempt, String(run.run_attempt), 'pipeline_deployment_summary_attempt_mismatch')
      const log = (await api(`${repository}/actions/jobs/${job.id}/logs`, { bytes: true })).toString('utf8')
      // Private deployment independently validates all manifests. This also
      // rejects an artifact name supplied by a different job in the same run.
      assert.ok(log.includes(`Artifact ${packet.artifact.name}.zip successfully finalized.`)
        && log.includes(`Artifact ID ${packet.artifact.id}`), 'pipeline_summary_upload_evidence_required')
      // Only the separate preflight can prove rejection before any writer; its
      // failed run has a skipped Deploy step and was handled above. Once this
      // step ran, an admission label cannot hide a possibly partial deployment.
      assert.equal(summary.admission, undefined, 'pipeline_previous_release_requires_recovery')
      assert.notEqual(summary.failedStep, 'migration-identity', 'pipeline_previous_release_requires_recovery')
      // A run that failed before its first migration or service write changed nothing (baselineOrigin),
      // so it neither blocks nor sets the baseline: the baseline is what the writer before it left.
      // Its own previousOrigin is only what its selection believed, which can be stale.
      if (summary.status === 'failed' && preWriteSteps.includes(summary.failedStep) && summary.rollback === undefined) continue
      assert.ok(found === undefined || interval.start > foundInterval.end, 'pipeline_deployment_order_ambiguous')
      found = { run, summary, files: packet.files }
      foundInterval = interval
      break
    }
  }
  if (found !== undefined) return found
  assert.ok(!selectedRun, 'pipeline_requested_release_missing')
  return null
}

const attemptStart = run => {
  const at = Date.parse(run.run_started_at ?? '')
  assert.ok(Number.isFinite(at), 'pipeline_deployment_start_required')
  return at
}

const deploymentInterval = step => {
  const start = typeof step.started_at === 'string' ? Date.parse(step.started_at) : NaN
  const end = typeof step.completed_at === 'string' ? Date.parse(step.completed_at) : NaN
  assert.ok(Number.isFinite(start) && Number.isFinite(end) && end >= start, 'pipeline_deployment_interval_required')
  return { start, end }
}

async function qualificationOrigin(api) {
  const runs = await pages(api, 'actions/workflows/cloud-services-ci.yml/runs?branch=main&status=success', 'workflow_runs')
  for (const run of runs) {
    checkedRun(run, qualification, { event: 'workflow_dispatch' })
    const artifacts = await pages(api, `actions/runs/${run.id}/artifacts`, 'artifacts')
    if (!artifacts.some(artifact => !artifact.expired && artifact.name === `cloud-services-ci-receipt-${run.id}-${run.run_attempt}`)) continue
    const artifact = artifactFor(run, artifacts, 'cloud-services-ci-receipt')
    return { runId: String(run.id), runAttempt: String(run.run_attempt), artifactId: String(artifact.id) }
  }
  throw new Error('pipeline_operations_qualification_required')
}

/** Selection is read-only. The private publisher rechecks source ancestry,
 * original jobs, upload logs, archive bytes and member digests before writers. */
export async function selectPipeline({ env = process.env, api = github } = {}) {
  assert.ok(actionsMikkaRepository(env), 'pipeline_repository_scope')
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'pipeline_main_ref_required')
  if (env.GITHUB_EVENT_NAME === 'workflow_run') assert.ok(trustedActor({ id: env.GITHUB_ACTOR_ID, login: env.GITHUB_ACTOR }, true), 'pipeline_actor_untrusted')
  const report = resolve(env.RUNNER_TEMP, 'deploy-pipeline')
  await mkdir(report, { recursive: true, mode: 0o700 })
  let selected, previous, rollback
  if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'))
    selected = await release(api, event.workflow_run?.id, event.workflow_run?.run_attempt)
    const main = await api(`${repository}/git/ref/heads/main`)
    if (selectAutomaticCandidate(event, selected.run, main.object?.sha) === 'superseded') return { status: 'superseded', source: selected.manifest.sourceCommit }
  } else {
    assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'pipeline_dispatch_event_required')
    assert.ok(['pipeline-stage', 'pipeline-rollback'].includes(env.MIKKA_DEPLOYMENT_PHASE), 'pipeline_deployment_phase_invalid')
    if (env.MIKKA_DEPLOYMENT_PHASE === 'pipeline-rollback') {
      assert.match(env.INPUT_PIPELINE_RUN ?? '', number, 'pipeline_rollback_run_required')
      rollback = await priorDeployment(api, env.GITHUB_RUN_ID, env.INPUT_PIPELINE_RUN)
      selected = await historicalRelease(api, rollback.summary.origin.runId, rollback.summary.origin.runAttempt)
      if (rollback.summary.previousOrigin) previous = await historicalRelease(api, rollback.summary.previousOrigin.runId, rollback.summary.previousOrigin.runAttempt)
    } else selected = await release(api, env.INPUT_RELEASE_RUN)
  }
  if (!rollback) {
    const prior = await priorDeployment(api, env.GITHUB_RUN_ID)
    const origin = prior && baselineOrigin(prior.summary)
    if (origin) previous = await historicalRelease(api, origin.runId, origin.runAttempt)
  }
  const cloud = await api('alexj11324/mikka-cloud/git/ref/heads/main')
  assert.match(cloud.object?.sha ?? '', sha, 'pipeline_operations_sha_required')
  if (env.INPUT_CLOUD_SOURCE) assert.equal(env.INPUT_CLOUD_SOURCE, cloud.object.sha, 'pipeline_operations_source_must_be_current_main')
  const ops = await qualificationOrigin(api)
  const manifestPath = resolve(report, 'release-manifest.json')
  await writeFile(manifestPath, JSON.stringify(selected.manifest, null, 2) + '\n', { mode: 0o600 })
  const variables = { MIKKA_RELEASE_MANIFEST: manifestPath, MIKKA_RELEASE_RUN_ID: selected.origin.runId,
    MIKKA_RELEASE_RUN_ATTEMPT: selected.origin.runAttempt, MIKKA_RELEASE_ARTIFACT_ID: selected.origin.artifactId,
    MIKKA_CF_OPERATIONS_SHA: cloud.object.sha, MIKKA_CLOUD_SOURCE_SHA: cloud.object.sha,
    MIKKA_OPERATIONS_CI_RUN_ID: ops.runId, MIKKA_OPERATIONS_CI_RUN_ATTEMPT: ops.runAttempt,
    MIKKA_OPERATIONS_CI_ARTIFACT_ID: ops.artifactId, MIKKA_PIPELINE_TARGET: 'staging',
    MIKKA_PIPELINE_RECEIPT: resolve(env.RUNNER_TEMP, 'deploy-pipeline-private.json'),
    MIKKA_PIPELINE_SUMMARY: resolve(report, 'pipeline-summary.json') }
  if (previous) {
    variables.MIKKA_PREVIOUS_MANIFEST = resolve(report, 'previous-manifest.json')
    await writeFile(variables.MIKKA_PREVIOUS_MANIFEST, JSON.stringify(previous.manifest, null, 2) + '\n', { mode: 0o600 })
    for (const [key, value] of Object.entries(previous.origin)) variables['MIKKA_PREVIOUS_RELEASE_' + { runId: 'RUN_ID', runAttempt: 'RUN_ATTEMPT', artifactId: 'ARTIFACT_ID' }[key]] = value
  }
  if (rollback) {
    variables.MIKKA_ROLLBACK_RECEIPT = resolve(env.RUNNER_TEMP, 'deploy-pipeline-rollback.json')
    await writeFile(variables.MIKKA_ROLLBACK_RECEIPT, JSON.stringify(rollback.summary) + '\n', { mode: 0o600 })
  }
  for (const value of Object.values(variables)) assert.ok(!/[\r\n]/.test(value), 'pipeline_env_value_invalid')
  await appendFile(env.GITHUB_ENV, Object.entries(variables).map(([key, value]) => `${key}=${value}\n`).join(''))
  const output = { status: 'selected', source: selected.manifest.sourceCommit, operations: cloud.object.sha, report,
    releaseRun: selected.origin.runId, releaseAttempt: selected.origin.runAttempt, releaseArtifact: selected.origin.artifactId }
  return output
}

const forbiddenDispatchers = new Set([trustedActors.mergeQueue.id, '41898282'])

/** A manual promotion: a listed promoter (the owner or an agent, policy `promoters`) dispatches
 * `pipeline-promote` naming a completed merge-triggered staging run and the exact commit it staged.
 * Evidence, not identity, decides: this run must be the reviewed main workflow, both its actor and
 * whoever started this attempt must be promoters on current private main, and the staged run, the
 * manifest, the no-downgrade rule and every required production check must hold. All of this runs
 * before any deployment credential is read; only the read-only private source token is used. */
const daemonFloorPath = 'packages/protocol/src/device.ts'
const plainVersion = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/
const versionAtLeast = (version, floor) => {
  const [a, b] = [version, floor].map(value => plainVersion.exec(value ?? '')?.slice(1).map(Number))
  if (!a || !b) return false
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index]
  return true
}

export async function npmLatestDaemon(fetchImpl = fetch) {
  try {
    const response = await fetchImpl('https://registry.npmjs.org/@aspectlylabs%2fmikka/latest', { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return undefined
    return (await response.json())?.version
  } catch { return undefined }
}

/** A candidate that raises MIN_DAEMON_VERSION above npm `latest` would refuse every installed daemon:
 * move `latest` first (publish-daemon.yml promotion), then promote production. */
async function daemonFloorReached(api, sourceCommit, npmLatest) {
  const file = await api(`${repository}/contents/${daemonFloorPath}?ref=${sourceCommit}`)
  const text = file?.encoding === 'base64' ? Buffer.from(String(file.content ?? ''), 'base64').toString('utf8') : ''
  // Only a real declaration at the start of a line counts; a commented-out or quoted copy does not.
  const floor = /^export const MIN_DAEMON_VERSION = '([0-9.]+)'$/m.exec(text)?.[1]
  assert.match(floor ?? '', plainVersion, 'pipeline_daemon_floor_unreadable')
  const latest = await npmLatest()
  // An unreadable registry (npmLatestDaemon returns undefined) refuses exactly like a version behind the floor.
  if (!versionAtLeast(latest, floor)) throw new Error('pipeline_daemon_latest_behind',
    { cause: new Error(latest === undefined ? 'npm:latestUnreadable' : 'npm:latestBehind') })
}

/** The private release policy at one operations commit, fully validated; anything else is unreadable. */
async function readProductionPolicy(api, operations) {
  return checkedReleasePolicy(policyFromContents(await api(`alexj11324/mikka-cloud/contents/${POLICY_PATH}?ref=${operations}`)).policy)
}

async function manualStage(api, env) {
  assert.equal(env.MIKKA_DEPLOYMENT_PHASE, 'pipeline-promote', 'pipeline_deployment_phase_invalid')
  // Merge and Actions automation never promote, whatever the list says.
  assert.ok(!forbiddenDispatchers.has(String(env.GITHUB_ACTOR_ID)), 'pipeline_actor_untrusted')
  assert.match(env.INPUT_PIPELINE_RUN ?? '', number, 'pipeline_promotion_stage_run_required')
  assert.match(env.INPUT_PROMOTE_SOURCE ?? '', sha, 'pipeline_promotion_source_required')
  assert.notEqual(env.INPUT_PIPELINE_RUN, env.GITHUB_RUN_ID, 'pipeline_promotion_stage_run_required')
  // The running workflow is main's own file at the dispatched main commit, not a branch edit.
  assert.equal(env.GITHUB_WORKFLOW_REF, `${env.GITHUB_REPOSITORY}/${deployment}@refs/heads/main`, 'pipeline_workflow_ref_required')
  assert.equal(env.GITHUB_WORKFLOW_SHA, env.GITHUB_SHA, 'pipeline_workflow_ref_required')
  const current = await api(`${repository}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`)
  assert.ok(current?.path === deployment && current.event === 'workflow_dispatch' && current.head_branch === 'main'
    && current.head_sha === env.GITHUB_SHA && String(current.id) === env.GITHUB_RUN_ID
    && String(current.run_attempt) === env.GITHUB_RUN_ATTEMPT && String(current.actor?.id) === String(env.GITHUB_ACTOR_ID)
    && current.actor?.login === env.GITHUB_ACTOR && current.triggering_actor?.login === env.GITHUB_TRIGGERING_ACTOR,
  'pipeline_run_identity_mismatch')
  const cloud = await api('alexj11324/mikka-cloud/git/ref/heads/main')
  assert.match(cloud.object?.sha ?? '', sha, 'pipeline_operations_sha_required')
  if (env.INPUT_CLOUD_SOURCE) assert.equal(env.INPUT_CLOUD_SOURCE, cloud.object.sha, 'pipeline_operations_source_must_be_current_main')
  let policy
  try {
    policy = await readProductionPolicy(api, cloud.object.sha)
    requirePromoters(policy, { actor: current.actor, triggeringActor: current.triggering_actor })
    requireCommittedPromoters(policy)
  } catch (cause) {
    const code = /^releasePolicy:(actorNotPromoter|triggeringActorNotPromoter|noPromoters)$/.test(cause?.message) ? 'pipeline_actor_not_promoter'
      : cause?.message === 'releasePolicy:promotersDiverged' ? 'pipeline_promoters_diverged' : 'pipeline_policy_unreadable'
    throw new Error(code, { cause })
  }
  const run = checkedRun(await api(`${repository}/actions/runs/${env.INPUT_PIPELINE_RUN}`), deployment,
    { event: 'workflow_run', automaticDeployment: true })
  assert.equal(String(run.id), env.INPUT_PIPELINE_RUN, 'pipeline_promotion_stage_run_mismatch')
  const jobs = await pages(api, `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs')
  const staged = jobs.filter(job => job.name === 'pipeline')
  const succeeded = name => staged[0]?.steps?.some(step => step.name === name && step.status === 'completed' && step.conclusion === 'success')
  assert.ok(staged.length === 1 && staged[0].status === 'completed' && staged[0].conclusion === 'success'
    && succeeded('Deploy and verify staged service manifest') && succeeded('Upload pipeline receipts'), 'pipeline_stage_incomplete')
  const stage = await members(api, run, 'deploy-pipeline')
  const summary = stage.files['pipeline-summary.json']
  assert.equal(summary?.version, 1, 'pipeline_summary_version_required')
  assert.equal(summary.target, 'staging', 'pipeline_stage_target_mismatch')
  assert.equal(summary.status, 'passed', 'pipeline_stage_incomplete')
  assert.equal(summary.rollback, undefined, 'pipeline_stage_rollback_rejected')
  assert.equal(summary.verification?.status, 'pass', 'pipeline_summary_verification_required')
  assert.equal(summary.deployment?.runId, String(run.id), 'pipeline_deployment_summary_run_mismatch')
  assert.equal(summary.deployment.runAttempt, String(run.run_attempt), 'pipeline_deployment_summary_attempt_mismatch')
  assert.equal(summary.origin?.event, 'push', 'pipeline_promotion_release_mismatch')
  const selected = await release(api, summary.origin.runId, summary.origin.runAttempt)
  assert.equal(selected.origin.artifactId, String(summary.origin.artifactId), 'pipeline_promotion_release_mismatch')
  assert.equal(selected.manifest.sourceCommit, env.INPUT_PROMOTE_SOURCE, 'pipeline_promotion_source_mismatch')
  // The candidate must still be what staging serves: a later staging run or rollback replaces it.
  const latestStaging = await priorDeployment(api, env.GITHUB_RUN_ID, undefined, 'staging')
  assert.ok(latestStaging && String(latestStaging.run.id) === String(run.id) && String(latestStaging.run.run_attempt) === String(run.run_attempt)
    && latestStaging.summary?.rollback === undefined && latestStaging.summary?.status === 'passed', 'pipeline_stage_not_current')
  return { selected, stage, stageRun: run, operations: cloud.object.sha, policy }
}

/** Production consumes a completed staging artifact with its own serving baseline. It never
 * silently uses the staging baseline. An automatic run promotes the staging result of this same
 * run, and only while the private policy's `autoProduction` is true at the operations commit it
 * deploys (the workflow skips it otherwise, and this re-reads it); a manual dispatch by a listed
 * promoter promotes the named staging run instead. Either way the policy's production
 * `requiredChecks` must pass on the candidate's source commit before anything is exported.
 *
 * An automatic run whose candidate is merely not ready yet (a required check run with no success
 * yet, or npm `latest` below or unreadable against its daemon floor) returns `not-ready` instead of
 * failing: nothing has been written, production is skipped, the step summary says why and how to
 * recover, and the run still concludes successfully so a promoter can later dispatch
 * `pipeline-promote` for this exact staging run, which re-runs every gate. */
export async function selectPromotion({ env = process.env, api = github, npmLatest = npmLatestDaemon } = {}) {
  assert.ok(actionsMikkaRepository(env), 'pipeline_repository_scope')
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'pipeline_main_ref_required')
  const manual = env.GITHUB_EVENT_NAME === 'workflow_dispatch'
  if (!manual) assert.equal(env.GITHUB_EVENT_NAME, 'workflow_run', 'pipeline_workflow_run_event_required')
  // A merge through the merge queue promotes like the owner's own push (Alex 2026-11-24).
  if (!manual) assert.ok(trustedActor({ id: env.GITHUB_ACTOR_ID, login: env.GITHUB_ACTOR }, true), 'pipeline_actor_untrusted')
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', ...(manual ? [] : ['INPUT_STAGE_ARTIFACT'])])
    assert.match(env[key] ?? '', number, 'pipeline_promotion_input_required')
  if (!manual) assert.match(env.INPUT_OPERATIONS_SOURCE ?? '', sha, 'pipeline_operations_source_required')
  let selected, stage, stageRun, operations, policy
  if (manual) ({ selected, stage, stageRun, operations, policy } = await manualStage(api, env))
  else {
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'))
    selected = await release(api, event.workflow_run?.id, event.workflow_run?.run_attempt)
    stageRun = await api(`${repository}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`)
    assert.ok(String(stageRun.id) === env.GITHUB_RUN_ID && String(stageRun.run_attempt) === env.GITHUB_RUN_ATTEMPT, 'pipeline_stage_run_mismatch')
    stage = await members(api, stageRun, 'deploy-pipeline')
    assert.equal(String(stage.artifact.id), env.INPUT_STAGE_ARTIFACT, 'pipeline_stage_artifact_mismatch')
    operations = env.INPUT_OPERATIONS_SOURCE
    // The same file the staging job's switch read, at the operations commit this run deploys.
    try { policy = await readProductionPolicy(api, operations) } catch (cause) { throw new Error('pipeline_policy_unreadable', { cause }) }
    assert.equal(policy.autoProduction, true, 'pipeline_auto_production_disabled')
  }
  assert.deepEqual(stage.files['release-manifest.json'], selected.manifest, 'pipeline_stage_manifest_mismatch')
  assert.equal(stage.files['pipeline-summary.json']?.status, 'passed', 'pipeline_stage_incomplete')
  assert.equal(stage.files['pipeline-summary.json'].target, 'staging', 'pipeline_stage_target_mismatch')
  assert.equal(stage.files['pipeline-summary.json'].rollback, undefined, 'pipeline_stage_rollback_rejected')
  try {
    // Every promotion, automatic or manual: npm latest must already satisfy the candidate's daemon floor,
    await daemonFloorReached(api, selected.manifest.sourceCommit, npmLatest)
    // and the policy's production evidence must pass on the exact commit.
    try {
      await runReleaseChecks('production', { checks: policy.requiredChecks.production, sourceCommit: selected.manifest.sourceCommit,
        read: path => api(`${repository}/${path}`), builtin: {} })
    } catch (cause) { throw new Error('pipeline_required_check_failed', { cause }) }
  } catch (error) {
    if (manual || !notReady(error)) throw error
    const output = { status: 'not-ready', source: selected.manifest.sourceCommit, reason: selectionError(error),
      detail: refusalDetail(error), check: /^[a-z0-9][a-z0-9-]{0,63}$/.test(error.cause?.check ?? '') ? error.cause.check : '' }
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, notReadySummary(output, env.GITHUB_RUN_ID))
    return output
  }
  const prior = await priorDeployment(api, env.GITHUB_RUN_ID, undefined, 'production')
  const previousOrigin = prior && baselineOrigin(prior.summary, 'production')
  const previous = previousOrigin && await historicalRelease(api, previousOrigin.runId, previousOrigin.runAttempt)
  // A hand-picked candidate never moves production backwards: it must contain what production serves.
  if (manual && previous) {
    const compared = await api(`${repository}/compare/${previous.manifest.sourceCommit}...${selected.manifest.sourceCommit}`)
    assert.ok(['identical', 'ahead'].includes(compared?.status), 'pipeline_promotion_downgrade_rejected')
  }
  const qualification = await qualificationOrigin(api)
  const report = resolve(env.RUNNER_TEMP, 'deploy-production')
  await mkdir(report, { recursive: true, mode: 0o700 })
  const variables = { MIKKA_RELEASE_MANIFEST: resolve(report, 'release-manifest.json'),
    MIKKA_RELEASE_RUN_ID: selected.origin.runId, MIKKA_RELEASE_RUN_ATTEMPT: selected.origin.runAttempt,
    MIKKA_RELEASE_ARTIFACT_ID: selected.origin.artifactId,
    MIKKA_CF_OPERATIONS_SHA: operations, MIKKA_CLOUD_SOURCE_SHA: operations,
    MIKKA_OPERATIONS_CI_RUN_ID: qualification.runId, MIKKA_OPERATIONS_CI_RUN_ATTEMPT: qualification.runAttempt,
    MIKKA_OPERATIONS_CI_ARTIFACT_ID: qualification.artifactId, MIKKA_PIPELINE_TARGET: 'production',
    MIKKA_STAGE_RUN_ID: String(stageRun.id), MIKKA_STAGE_RUN_ATTEMPT: String(stageRun.run_attempt),
    MIKKA_STAGE_ARTIFACT_ID: String(stage.artifact.id),
    MIKKA_PIPELINE_RECEIPT: resolve(env.RUNNER_TEMP, 'deploy-production-private.json'),
    MIKKA_PIPELINE_SUMMARY: resolve(report, 'pipeline-summary.json') }
  await writeFile(variables.MIKKA_RELEASE_MANIFEST, JSON.stringify(selected.manifest, null, 2) + '\n', { mode: 0o600 })
  if (previous) {
    variables.MIKKA_PRODUCTION_MANIFEST = resolve(report, 'previous-manifest.json')
    await writeFile(variables.MIKKA_PRODUCTION_MANIFEST, JSON.stringify(previous.manifest, null, 2) + '\n', { mode: 0o600 })
    for (const [key, value] of Object.entries(previous.origin)) variables['MIKKA_PRODUCTION_RELEASE_' + { runId: 'RUN_ID', runAttempt: 'RUN_ATTEMPT', artifactId: 'ARTIFACT_ID' }[key]] = value
  }
  for (const value of Object.values(variables)) assert.ok(!/[\r\n]/.test(value), 'pipeline_env_value_invalid')
  await appendFile(env.GITHUB_ENV, Object.entries(variables).map(([key, value]) => `${key}=${value}\n`).join(''))
  return { status: 'selected', source: selected.manifest.sourceCommit, operations, report }
}

// Node 24 appends the assertion diff to a custom message; report only the code.
export function selectionError(error) {
  const code = error instanceof Error ? error.message.split('\n', 1)[0] : ''
  return /^pipeline_[a-z_]+$/.test(code) ? code : 'pipeline_selection_failed'
}

// Refusals an automatic run holds back instead of failing: no successful run yet of a listed check
// run (still pending, finished unsuccessfully, or never started, including one whose name or workflow
// path in the policy matches nothing), or npm latest below the daemon floor or unreadable. An unknown
// builtin check, a policy that fails its schema, and every integrity refusal still fail the run.
function notReady(error) {
  const reason = selectionError(error)
  const detail = refusalDetail(error)
  return reason === 'pipeline_daemon_latest_behind'
    || (reason === 'pipeline_required_check_failed' && ['releaseChecks:checkRunMissing', 'releaseChecks:checkRunFailed'].includes(detail))
}

/** The cause's own code (`releaseChecks:checkRunMissing`, `npm:latestUnreadable`, `releasePolicy:…`):
 * one `word:word_09` token, never free text. Anything else is dropped. */
export function refusalDetail(error) {
  const cause = error?.cause instanceof Error ? error.cause.message.split('\n', 1)[0] : ''
  return /^[A-Za-z][A-Za-z0-9_]*:[A-Za-z0-9_]+$/.test(cause) ? cause : ''
}

/** The step-summary block for a held-back automatic promotion: why, and the exact dispatch that recovers it. */
export function notReadySummary({ source, reason, detail, check }, runId) {
  const named = check ? `\`${check}\`` : 'the required check'
  const recover = condition => `**Recovery:** ${condition}, dispatch \`pipeline-promote\` with \`pipeline_run=${runId}\``
    + ` and \`promote_source=${source}\`. That dispatch re-runs every gate.`
  const kept = `Staging passed and stays; nothing was written to production. Code: \`${reason}\`${detail ? ` (\`${detail}\`)` : ''}.`
  let title, body
  if (detail === 'releaseChecks:checkRunFailed') {
    title = 'Production held back: a required check failed'
    body = `**Attention: this is likely a real failure.** The required production check ${named} finished unsuccessfully`
      + ` (failure, cancelled or timed out) on \`${source}\`. Investigate it, fix or re-run it, then promote.\n\n${kept}\n\n`
      + recover(`once ${named} passes on \`${source}\``)
  } else if (detail === 'releaseChecks:checkRunMissing') {
    title = 'Production held back: a required check has not passed yet'
    body = `The required production check ${named} has no successful run on \`${source}\` yet (queued, running or not started).`
      + ` If it never starts, compare its check run name and workflow path in the release policy with the workflow.\n\n${kept}\n\n`
      + recover(`once ${named} passes on \`${source}\``)
  } else {
    title = 'Production held back: npm latest does not meet the daemon floor'
    body = (detail === 'npm:latestUnreadable' ? 'The npm registry did not answer for `@aspectlylabs/mikka` `latest`.'
      : 'npm `latest` for `@aspectlylabs/mikka` is below the candidate\'s `MIN_DAEMON_VERSION`.')
      + ` Installed daemons would be refused.\n\n${kept}\n\n`
      + recover('once npm `latest` meets the floor (promote the daemon with `publish-daemon.yml` if it is behind)')
  }
  return `\n### ${title}\n\n${body}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === 'promote'), 'pipeline_usage_invalid')
    const output = await (process.argv[2] === 'promote' ? selectPromotion() : selectPipeline())
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
      Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(''))
    // The step summary carries the detail; a check that finished unsuccessfully is annotated as an error.
    if (output.status === 'not-ready') console.log(`${output.detail === 'releaseChecks:checkRunFailed'
      ? '::error title=Production held back: a required check failed' : '::warning title=Production held back'}::${output.reason}`
      + `${output.detail ? ` (${output.detail})` : ''}${output.check ? ` ${output.check}` : ''}: staging stands; see the step summary`
      + ` to dispatch pipeline-promote for this run once it is ready.`)
    console.log(JSON.stringify({ status: output.status, source: output.source }))
  } catch (error) {
    const detail = refusalDetail(error)
    console.error(selectionError(error) + (detail ? ` (${detail})` : ''))
    process.exitCode = 1
  }
}
