import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { artifactFor, baselineOrigin, checkedRun, github, priorDeployment, readArtifactMembers, selectAutomaticCandidate, selectPipeline, selectPromotion, selectionError } from './pipeline-inputs.mjs'
import { migrationRoots } from './migration-inputs.mjs'
import { serviceDigest, serviceNames } from './service-builds.mjs'

const source = 'a'.repeat(40)
const repo = { id: 1427517699, full_name: 'alexj11324/Mikka', fork: false, private: false }
const producer = '.github/workflows/cloudflare-api-image.yml'
const run = () => ({ id: 101, run_attempt: 2, path: producer, event: 'push', status: 'completed',
  conclusion: 'success', head_sha: source, head_branch: 'main', actor: { id: 183887963 },
  triggering_actor: { id: 183887963 }, repository: repo, head_repository: repo })
const event = original => ({ action: 'completed', repository: repo, workflow_run: structuredClone(original) })

function manifestFixture(commit = source, legacy = false) {
  const digest = 'sha256:' + 'b'.repeat(64)
  const manifest = { version: 1, sourceCommit: commit, overlayCommit: commit,
    services: Object.fromEntries(serviceNames.map(name => {
      const worker = ['web', 'world'].includes(name)
      const service = { kind: worker ? 'worker' : 'container', contextDigest: digest, sourceCommit: commit,
        overlayCommit: ['api', 'web'].includes(name) ? commit : null, reused: false,
        build: { runId: '101', runAttempt: '2', artifactId: '301', workflow: 'cloudflare-api-image.yml' },
        artifacts: { worker: { digest, path: 'workers/' + name + '.mjs' } },
        ...(!worker ? { image: 'registry.cloudflare.com/' + 'c'.repeat(32) + '/mikka-' + name + '@' + digest,
          imageDigest: digest, localImageId: digest } : {}) }
      return [name, { ...service, digest: serviceDigest(service) }]
    })), migrations: { version: 3, contextDigest: digest, files: ['drizzle/20261120000000_initial.sql'],
      execution: { entrypoint: 'scripts/migrate.mjs', contextDigest: digest, files: [...migrationRoots].sort(),
        runtime: { imports: [], lockfileVersion: '9.0', nodeMajor: 24, packages: [] } } } }
  if (legacy) { delete manifest.migrations.version; delete manifest.migrations.execution }
  return manifest
}

test('the completed main push selects only the latest queued source, without rewriting workflow identity', () => {
  const original = run()
  assert.equal(selectAutomaticCandidate(event(original), original, source), 'selected')
  assert.equal(selectAutomaticCandidate(event(original), original, 'b'.repeat(40)), 'superseded')
  const forged = event(original)
  forged.workflow_run.run_attempt = 1
  assert.throws(() => selectAutomaticCandidate(forged, original, source))
})

test('merge queue provenance is accepted only on automatic main runs with both bot identifiers', () => {
  const bot = { id: 118344674, login: 'github-merge-queue[bot]' }
  const original = { ...run(), actor: bot, triggering_actor: bot }
  assert.equal(selectAutomaticCandidate(event(original), original, source), 'selected')
  const rerun = { ...original, triggering_actor: { id: 183887963, login: 'alexj11324' } }
  assert.equal(selectAutomaticCandidate(event(rerun), rerun, source), 'selected')
  const deployed = { ...original, path: '.github/workflows/cloudflare-app-deploy.yml', event: 'workflow_run' }
  assert.equal(checkedRun(deployed, deployed.path, { automaticDeployment: true }).id, 101)
  assert.equal(checkedRun({ ...deployed, triggering_actor: rerun.triggering_actor }, deployed.path, { automaticDeployment: true }).id, 101)
  assert.throws(() => checkedRun(deployed, deployed.path))
  for (const actor of [{ ...bot, id: 7 }, { ...bot, login: 'outsider' }, { login: bot.login }, undefined]) {
    for (const field of ['actor', 'triggering_actor']) {
      const forged = { ...original, [field]: actor }
      assert.throws(() => selectAutomaticCandidate(event(forged), forged, source))
    }
  }
  // Dispatch is open to any repo writer: a bot-dispatched run passes the actor
  // check on every workflow path; event mismatches still throw.
  for (const path of [producer, '.github/workflows/cloud-services-ci.yml', '.github/workflows/cloudflare-app-deploy.yml'])
    assert.equal(checkedRun({ ...original, path, event: 'workflow_dispatch' }, path).id, 101)
  assert.throws(() => checkedRun({ ...original, path: producer, event: 'workflow_dispatch' }, producer, { event: 'push' }))
})

test('merge queue identity cannot select a manual stage or rollback, and an unknown actor cannot promote', async () => {
  const env = { GITHUB_REPOSITORY: repo.full_name, GITHUB_REPOSITORY_ID: '1427517699', GITHUB_REPOSITORY_OWNER_ID: '183887963',
    GITHUB_REF: 'refs/heads/main', GITHUB_ACTOR_ID: '118344674', GITHUB_ACTOR: 'github-merge-queue[bot]' }
  const api = async () => assert.fail('Untrusted selection must not read GitHub')
  for (const phase of ['pipeline-stage', 'pipeline-rollback'])
    await assert.rejects(selectPipeline({ env: { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', MIKKA_DEPLOYMENT_PHASE: phase }, api }))
  await assert.rejects(selectPromotion({ env: { ...env, GITHUB_EVENT_NAME: 'workflow_run', GITHUB_ACTOR_ID: '1', GITHUB_ACTOR: 'someone' }, api }),
    /pipeline_actor_untrusted/)
  await assert.rejects(selectPromotion({ env: { ...env, GITHUB_EVENT_NAME: 'workflow_run', GITHUB_ACTOR: 'other-bot' }, api }),
    /pipeline_actor_untrusted/)
})

test('failed builds, fork PRs, branches and different actors never become deployable candidates', () => {
  for (const change of [
    { conclusion: 'failure' }, { status: 'in_progress' }, { event: 'pull_request' },
    { head_branch: 'feature' }, { head_repository: { ...repo, fork: true } },
    { repository: { ...repo, private: true } }, { actor: { id: 123 } },
    { triggering_actor: { id: 123 } }, { path: '.github/workflows/other.yml' },
  ]) {
    const original = { ...run(), ...change }
    assert.throws(() => selectAutomaticCandidate(event(original), original, source))
  }
  assert.equal(checkedRun(run(), producer, { event: 'push' }).id, 101)
})

test('a failed stage blocks the next writer while a completed rollback restores its previous origin', () => {
  const origin = { runId: '101', runAttempt: '2', artifactId: '301' }
  const previousOrigin = { runId: '99', runAttempt: '1', artifactId: '299' }
  const summary = { version: 1, target: 'staging', status: 'passed', verification: { status: 'pass' }, origin, previousOrigin }
  assert.deepEqual(baselineOrigin(summary), origin)
  assert.throws(() => baselineOrigin({ ...summary, status: 'failed' }), /requires_recovery/)
  assert.throws(() => baselineOrigin({ ...summary, verification: { status: 'fail' } }))
  assert.deepEqual(baselineOrigin({ ...summary, status: 'failed', rollback: { status: 'passed' } }), previousOrigin)
  assert.equal(baselineOrigin({ ...summary, previousOrigin: null, rollback: { status: 'passed' } }), null)
  for (const failedStep of ['artifacts', 'existing-resources']) {
    assert.deepEqual(baselineOrigin({ ...summary, status: 'failed', failedStep }), previousOrigin)
    assert.equal(baselineOrigin({ ...summary, target: 'production', status: 'failed', failedStep, previousOrigin: null }, 'production'), null)
    assert.throws(() => baselineOrigin({ ...summary, status: 'failed', failedStep, rollback: { status: 'failed' } }), /requires_recovery/)
    assert.throws(() => baselineOrigin({ ...summary, status: 'failed', failedStep, admission: 'rejected' }), /requires_recovery/)
  }
  for (const failedStep of ['migrations', 'api', 'manifest-readback', 'production-probes', 'staging-probes', undefined])
    assert.throws(() => baselineOrigin({ ...summary, status: 'failed', failedStep }), /requires_recovery/)
  assert.throws(() => baselineOrigin({ ...summary, target: 'staging' }, 'production'))
  assert.deepEqual(baselineOrigin({ ...summary, target: 'production' }, 'production'), origin)
})

test('artifact selection requires the original attempt, complete provenance, immutable digest and unexpired bytes', () => {
  const original = run()
  const artifact = { id: 301, name: 'release-manifest-101-2', expired: false, size_in_bytes: 100,
    digest: 'sha256:' + 'c'.repeat(64), workflow_run: { id: 101, head_sha: source, head_branch: 'main',
      repository_id: 1427517699, head_repository_id: 1427517699 } }
  assert.equal(artifactFor(original, [artifact], 'release-manifest'), artifact)
  for (const changes of [{ expired: true }, { name: 'release-manifest-101-1' }, { digest: null },
    { workflow_run: { ...artifact.workflow_run, head_sha: 'b'.repeat(40) } },
    { workflow_run: { ...artifact.workflow_run, head_repository_id: 1 } }]) {
    assert.throws(() => artifactFor(original, [{ ...artifact, ...changes }], 'release-manifest'))
  }
  assert.throws(() => artifactFor(original, [artifact, artifact], 'release-manifest'))
})

test('a rerun that fails before its writer cannot hide an earlier partial deployment, including its own prior attempt', async () => {
  const original = { ...run(), path: '.github/workflows/cloudflare-app-deploy.yml', event: 'workflow_run',
    conclusion: 'failure', run_attempt: 1 }
  const latest = { ...original, run_attempt: 2 }
  const summary = { version: 1, target: 'staging', status: 'failed',
    deployment: { runId: '101', runAttempt: '1' }, origin: { runId: '100', runAttempt: '1', artifactId: '299' } }
  const bytes = execFileSync('python3', ['-c',
    'import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w") as z: z.writestr("pipeline-summary.json",sys.argv[1])\nsys.stdout.buffer.write(b.getvalue())', JSON.stringify(summary)])
  const artifact = { id: 301, name: 'deploy-pipeline-101-1', expired: false, size_in_bytes: bytes.length,
    digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    workflow_run: { id: 101, head_sha: source, head_branch: 'main', repository_id: repo.id, head_repository_id: repo.id } }
  for (const currentRun of ['200', '101']) {
    const calls = []
    const api = async path => {
      calls.push(path)
      if (path.includes('actions/workflows/')) return { total_count: 1,
        workflow_runs: [{ ...latest, ...(currentRun === '101' ? { status: 'in_progress', conclusion: null } : {}) }] }
      if (path.endsWith('/attempts/1')) return original
      if (path.includes('/attempts/2/jobs?')) return { total_count: 1, jobs: [{ id: 402, name: 'pipeline',
        status: 'completed', conclusion: 'failure', steps: [
          { name: 'Preflight migration identity before product code and credentials', status: 'completed', conclusion: 'failure' },
          { name: 'Deploy and verify staged service manifest', conclusion: 'skipped' },
        ] }] }
      if (path.includes('/attempts/1/jobs?')) return { total_count: 1, jobs: [{ id: 401, name: 'pipeline',
        status: 'completed', conclusion: 'failure', steps: [{ name: 'Deploy and verify staged service manifest', conclusion: 'failure' }] }] }
      if (path.includes('/runs/101/artifacts?')) return { total_count: 1, artifacts: [artifact] }
      if (path.endsWith('/artifacts/301/zip')) return bytes
      if (path.endsWith('/jobs/401/logs')) return Buffer.from('Artifact deploy-pipeline-101-1.zip successfully finalized.\nArtifact ID 301')
      assert.fail('Unexpected metadata request: ' + path)
    }
    const prior = await priorDeployment(api, currentRun)
    assert.equal(prior.run.run_attempt, 1)
    assert.deepEqual(prior.summary, summary)
    assert.throws(() => baselineOrigin(prior.summary), /requires_recovery/)
    assert.equal(calls.some(path => path.includes('/attempts/2/jobs?')), currentRun !== '101')
  }
})

test('a Deploy step that failed before its first receipt is skipped, but a printed summary still blocks', async () => {
  const zip = members => execFileSync('python3', ['-c',
    'import io,sys,json,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w") as z:\n  for k,v in json.loads(sys.argv[1]).items(): z.writestr(k,v)\nsys.stdout.buffer.write(b.getvalue())',
    JSON.stringify(members)])
  const failed = { ...run(), id: 202, path: '.github/workflows/cloudflare-app-deploy.yml', event: 'workflow_run', conclusion: 'failure', run_attempt: 1 }
  const older = { ...failed, id: 201 }
  const summary = { version: 1, target: 'staging', status: 'failed', rollback: { status: 'passed' }, previousOrigin: null,
    deployment: { runId: '201', runAttempt: '1' }, origin: { runId: '100', runAttempt: '1', artifactId: '299' } }
  const empty = zip({ 'release-manifest.json': JSON.stringify(manifestFixture()) })
  const full = zip({ 'pipeline-summary.json': JSON.stringify(summary) })
  const artifactOf = (id, runId, bytes) => ({ id, name: `deploy-pipeline-${runId}-1`, expired: false, size_in_bytes: bytes.length,
    digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    workflow_run: { id: runId, head_sha: source, head_branch: 'main', repository_id: repo.id, head_repository_id: repo.id } })
  for (const printed of [false, true]) {
    const api = async path => {
      if (path.includes('actions/workflows/')) return { total_count: 2, workflow_runs: [failed, older] }
      const id = path.includes('/runs/202/') ? 202 : 201
      if (path.includes('/attempts/1/jobs?')) return { total_count: 1, jobs: [{ id: id + 300, name: 'pipeline', status: 'completed',
        conclusion: 'failure', steps: [{ name: 'Deploy and verify staged service manifest', status: 'completed', conclusion: 'failure' }] }] }
      if (path.includes('/runs/202/artifacts?')) return { total_count: 1, artifacts: [artifactOf(402, 202, empty)] }
      if (path.includes('/runs/201/artifacts?')) return { total_count: 1, artifacts: [artifactOf(401, 201, full)] }
      if (path.endsWith('/artifacts/402/zip')) return empty
      if (path.endsWith('/artifacts/401/zip')) return full
      if (path.endsWith('/jobs/502/logs')) return Buffer.from((printed ? 'MIKKA_DEPLOYMENT_PIPELINE={}\n' : '')
        + 'Artifact deploy-pipeline-202-1.zip successfully finalized.\nArtifact ID 402')
      if (path.endsWith('/jobs/501/logs')) return Buffer.from('Artifact deploy-pipeline-201-1.zip successfully finalized.\nArtifact ID 401')
      assert.fail('Unexpected metadata request: ' + path)
    }
    if (printed) await assert.rejects(priorDeployment(api, '300'), /pipeline_deployment_summary_missing/)
    else {
      const prior = await priorDeployment(api, '300')
      assert.equal(prior.run.id, 201)
      assert.equal(baselineOrigin(prior.summary), null)
    }
  }
})

test('an executed deployment cannot use a forged admission report to hide a partial release', async () => {
  for (const target of ['staging', 'production']) for (const status of ['failed', 'passed']) {
    const original = { ...run(), id: 201, path: '.github/workflows/cloudflare-app-deploy.yml', event: 'workflow_run',
      conclusion: 'failure', run_attempt: 1 }
    const summary = { version: 1, target, status, admission: 'rejected', failedStep: 'migration-identity',
      failureCode: 'migration_execution_changed', sourceCommit: source, previousSourceCommit: null,
      manifestSha256: 'b'.repeat(64), changedServices: [], retainedServices: [], services: {}, productionPromoted: false,
      origin: { source, runId: '101', runAttempt: '2', artifactId: '301', event: 'push', archiveSha256: 'c'.repeat(64) },
      previousOrigin: null, deployment: { runId: '201', runAttempt: '1', driverSource: source, operationsSource: 'd'.repeat(40) },
      operationsQualification: { runId: '301', runAttempt: '1', artifactId: '302', privateSource: 'e'.repeat(40) },
      ...(status === 'passed' ? { verification: { status: 'pass' } } : {}) }
    const bytes = execFileSync('python3', ['-c',
      'import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w") as z: z.writestr("pipeline-summary.json",sys.argv[1])\nsys.stdout.buffer.write(b.getvalue())', JSON.stringify(summary)])
    const prefix = target === 'production' ? 'deploy-production' : 'deploy-pipeline'
    const artifact = { id: 401, name: `${prefix}-201-1`, expired: false, size_in_bytes: bytes.length,
      digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      workflow_run: { id: 201, head_sha: source, head_branch: 'main', repository_id: repo.id, head_repository_id: repo.id } }
    const calls = []
    const api = async path => {
      calls.push(path)
      if (path.includes('actions/workflows/')) return { total_count: 2, workflow_runs: [original, { ...original, id: 199 }] }
      if (path.includes('/runs/201/attempts/1/jobs?')) return { total_count: 1, jobs: [{ id: 402,
        name: target === 'production' ? 'pipeline-production' : 'pipeline', status: 'completed', conclusion: 'failure',
        steps: [{ name: target === 'production' ? 'Promote and verify the staged service manifest' : 'Deploy and verify staged service manifest',
          status: 'completed', conclusion: 'failure' }] }] }
      if (path.includes('/runs/201/artifacts?')) return { total_count: 1, artifacts: [artifact] }
      if (path.endsWith('/artifacts/401/zip')) return bytes
      if (path.endsWith('/jobs/402/logs')) return Buffer.from(`MIKKA_DEPLOYMENT_PIPELINE=${JSON.stringify(summary)}\nArtifact ${artifact.name}.zip successfully finalized.\nArtifact ID 401`)
      assert.fail('A forged admission reached older history: ' + path)
    }
    await assert.rejects(priorDeployment(api, '300', undefined, target), /requires_recovery/)
    assert.equal(calls.some(path => path.includes('/runs/199/')), false)
  }
})

test('archive bytes are authenticated and traversal, duplicate members and unexpected private files are rejected', () => {
  const zip = names => execFileSync('python3', ['-c',
    'import io,sys,zipfile,json\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w") as z:\n for name in json.loads(sys.argv[1]): z.writestr(name,"{\\"version\\":1}")\nsys.stdout.buffer.write(b.getvalue())', JSON.stringify(names)], { stdio: ['ignore', 'pipe', 'pipe'] })
  const metadata = bytes => ({ size_in_bytes: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') })
  const good = zip(['release-manifest.json'])
  assert.deepEqual(readArtifactMembers(good, metadata(good)), { 'release-manifest.json': { version: 1 } })
  assert.throws(() => readArtifactMembers(good, { ...metadata(good), digest: 'sha256:' + '0'.repeat(64) }))
  for (const names of [['../release-manifest.json'], ['release-manifest.json', 'release-manifest.json'], ['private-receipt.json']]) {
    const bytes = zip(names)
    assert.throws(() => readArtifactMembers(bytes, metadata(bytes)), /pipeline_artifact_format_invalid/)
  }
})

test('automatic, manual staging and production candidate selection require migration execution v3 before further requests', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-migration-candidate-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const env = { GITHUB_REPOSITORY: repo.full_name, GITHUB_REPOSITORY_ID: '1427517699', GITHUB_REPOSITORY_OWNER_ID: '183887963', GITHUB_REF: 'refs/heads/main', GITHUB_ACTOR_ID: '183887963',
    GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: join(directory, 'event.json'), RUNNER_TEMP: directory,
    GITHUB_RUN_ID: '201', GITHUB_RUN_ATTEMPT: '1', INPUT_STAGE_ARTIFACT: '401', INPUT_OPERATIONS_SOURCE: 'f'.repeat(40) }
  await writeFile(env.GITHUB_EVENT_PATH, JSON.stringify(event(run())))
  const manifest = manifestFixture()
  const old = structuredClone(manifest)
  delete old.migrations.version
  delete old.migrations.execution
  const incomplete = structuredClone(manifest)
  delete incomplete.migrations.execution
  const candidateApi = candidate => {
    const calls = []
    const bytes = execFileSync('python3', ['-c',
      'import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w") as z: z.writestr("release-manifest.json",sys.argv[1])\nsys.stdout.buffer.write(b.getvalue())', JSON.stringify(candidate)])
    const artifact = { id: 301, name: 'release-manifest-101-2', expired: false, size_in_bytes: bytes.length,
      digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      workflow_run: { id: 101, head_sha: source, head_branch: 'main', repository_id: repo.id, head_repository_id: repo.id } }
    const api = async path => {
      calls.push(path)
      if (path.endsWith('/runs/101') || path.endsWith('/runs/101/attempts/2')) return run()
      if (path.includes('/runs/101/artifacts?')) return { total_count: 1, artifacts: [artifact] }
      if (path.endsWith('/artifacts/301/zip')) return bytes
      if (path.endsWith('/git/ref/heads/main')) return { object: { sha: 'd'.repeat(40) } }
      assert.fail('Candidate validation reached an unexpected request: ' + path)
    }
    return { api, calls }
  }
  for (const candidate of [old, incomplete]) {
    for (const selection of [
      api => selectPipeline({ env, api }),
      api => selectPipeline({ env: { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', MIKKA_DEPLOYMENT_PHASE: 'pipeline-stage', INPUT_RELEASE_RUN: '101' }, api }),
      api => selectPromotion({ env, api }),
    ]) {
      const { api, calls } = candidateApi(candidate)
      await assert.rejects(selection(api))
      assert.equal(calls.length, 3)
      assert.equal(calls.some(path => path.includes('mikka-cloud')), false)
    }
  }
  const valid = candidateApi(manifest)
  assert.equal((await selectPipeline({ env, api: valid.api })).status, 'superseded')
  assert.equal(valid.calls.length, 4)
})

test('promotion by the owner or the merge queue scans staging history and selects the staged release', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-promotion-history-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const env = { GITHUB_REPOSITORY: repo.full_name, GITHUB_REPOSITORY_ID: String(repo.id), GITHUB_REPOSITORY_OWNER_ID: '183887963',
    GITHUB_REF: 'refs/heads/main', GITHUB_ACTOR_ID: '183887963', GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_EVENT_PATH: join(directory, 'event.json'), GITHUB_ENV: join(directory, 'env'), RUNNER_TEMP: directory,
    GITHUB_RUN_ID: '201', GITHUB_RUN_ATTEMPT: '1', INPUT_STAGE_ARTIFACT: '401', INPUT_OPERATIONS_SOURCE: 'f'.repeat(40) }
  await writeFile(env.GITHUB_EVENT_PATH, JSON.stringify(event(run())))
  const manifest = manifestFixture()
  const current = { ...run(), id: 201, run_attempt: 1, path: '.github/workflows/cloudflare-app-deploy.yml', event: 'workflow_run' }
  const bot = { id: 118344674, login: 'github-merge-queue[bot]' }
  const earlier = { ...current, id: 199, actor: bot, triggering_actor: bot }
  const qualified = { ...run(), id: 501, run_attempt: 1, path: '.github/workflows/cloud-services-ci.yml', event: 'workflow_dispatch' }
  function packet(origin, id, prefix, files) {
    const bytes = execFileSync('python3', ['-c',
      'import io,json,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w") as z:\n for name,value in json.loads(sys.argv[1]).items(): z.writestr(name,json.dumps(value))\nsys.stdout.buffer.write(b.getvalue())', JSON.stringify(files)])
    return { bytes, artifact: { id, name: `${prefix}-${origin.id}-${origin.run_attempt}`, expired: false, size_in_bytes: bytes.length,
      digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), workflow_run: {
        id: origin.id, head_sha: source, head_branch: 'main', repository_id: repo.id, head_repository_id: repo.id } } }
  }
  const release = packet(run(), 301, 'release-manifest', { 'release-manifest.json': manifest })
  const stage = packet(current, 401, 'deploy-pipeline', { 'release-manifest.json': manifest,
    'pipeline-summary.json': { status: 'passed', target: 'staging' } })
  const qualification = packet(qualified, 601, 'cloud-services-ci-receipt', { 'receipt.json': {} })
  for (const production of [undefined, { name: 'pipeline-production', conclusion: 'skipped' }]) {
    let scanned = false
    const api = async path => {
      if (path.endsWith('/runs/101/attempts/2')) return run()
      if (path.endsWith('/runs/201/attempts/1')) return current
      for (const [id, value] of [[101, release], [201, stage], [501, qualification]]) {
        if (path.includes(`/runs/${id}/artifacts?`)) return { total_count: 1, artifacts: [value.artifact] }
        if (path.endsWith(`/artifacts/${value.artifact.id}/zip`)) return value.bytes
      }
      if (path.includes('workflows/cloudflare-app-deploy.yml/runs?')) return { total_count: 1, workflow_runs: [earlier] }
      if (path.includes('/runs/199/attempts/1/jobs?')) {
        scanned = true
        const jobs = [{ name: 'pipeline', status: 'completed', conclusion: 'success' }, ...(production ? [production] : [])]
        return { total_count: jobs.length, jobs }
      }
      if (path.includes('workflows/cloud-services-ci.yml/runs?')) return { total_count: 1, workflow_runs: [qualified] }
      if (path.endsWith(`/contents/packages/protocol/src/device.ts?ref=${source}`))
        return { encoding: 'base64', content: Buffer.from("// export const MIN_DAEMON_VERSION = '9.9.9'\nexport const MIN_DAEMON_VERSION = '0.0.456'\n").toString('base64') }
      assert.fail('Unexpected promotion request: ' + path)
    }
    const npmLatest = async () => '0.0.500'
    const result = await selectPromotion({ env, api, npmLatest })
    assert.equal(result.status, 'selected')
    assert.equal(result.source, source)
    assert.equal(scanned, true)
    scanned = false
    const queued = await selectPromotion({ env: { ...env, GITHUB_ACTOR_ID: String(bot.id), GITHUB_ACTOR: bot.login }, api, npmLatest })
    // The automatic path refuses a candidate whose daemon floor is above npm latest, too.
    await assert.rejects(selectPromotion({ env, api, npmLatest: async () => '0.0.455' }), /pipeline_daemon_latest_behind/)
    assert.equal(queued.status, 'selected')
    assert.equal(queued.source, source)
    assert.equal(scanned, true)
  }
})

test('canonical GitHub reads keep the Actions and private operations token scopes separate', async t => {
  const original = [process.env.GH_TOKEN, process.env.MIKKA_PUBLIC_ACTIONS_TOKEN]
  process.env.GH_TOKEN = 'private-fixture'
  process.env.MIKKA_PUBLIC_ACTIONS_TOKEN = 'public-fixture'
  t.after(() => {
    for (const [index, key] of ['GH_TOKEN', 'MIKKA_PUBLIC_ACTIONS_TOKEN'].entries()) {
      if (original[index] === undefined) delete process.env[key]
      else process.env[key] = original[index]
    }
  })
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    calls.push([url, options.headers.authorization])
    return Promise.resolve(Response.json({}))
  })
  await github('alexj11324/Mikka/actions/runs/1')
  await github('alexj11324/mikka-cloud/git/ref/heads/main')
  await assert.rejects(github('other/Mikka/actions/runs/1'), /pipeline_repository_scope/)
  assert.deepEqual(calls, [
    ['https://api.github.com/repositories/1427517699/actions/runs/1', 'Bearer public-fixture'],
    ['https://api.github.com/repositories/1448851980/git/ref/heads/main', 'Bearer private-fixture'],
  ])
})

test('a completed stage-all resets the staging baseline to bootstrap without affecting production or other phases', async () => {
  const stageAllRun = { ...run(), id: 250, run_attempt: 1, path: '.github/workflows/cloudflare-app-deploy.yml', event: 'workflow_dispatch' }
  const olderStage = { ...run(), id: 240, run_attempt: 1, path: '.github/workflows/cloudflare-app-deploy.yml', event: 'workflow_run' }
  const applyStep = { name: 'Deploy the reviewed public artifacts and verify the selected phase', conclusion: 'success' }
  const receiptLine = phase => Buffer.from(
    `2026-11-24T18:00:00Z MIKKA_PUBLIC_DEPLOYMENT_PHASE=${JSON.stringify({ version: 1, phase, status: 'completed', operator: { runId: '250', runAttempt: '1' } })}\n`,
  )
  const makeApi = phase => async path => {
    if (path.includes('workflows/cloudflare-app-deploy.yml/runs?')) return { total_count: 2, workflow_runs: [stageAllRun, olderStage] }
    if (path.includes('/runs/250/attempts/1/jobs?')) return { total_count: 1, jobs: [{ id: 9001, name: 'deploy-application', status: 'completed', conclusion: 'success', steps: [applyStep] }] }
    if (path.endsWith('/jobs/9001/logs')) return receiptLine(phase)
    if (path.includes('/runs/240/attempts/1/jobs?')) return { total_count: 1, jobs: [{ id: 9000, name: 'pipeline', status: 'completed', conclusion: 'skipped' }] }
    assert.fail('Unexpected request: ' + path)
  }
  assert.equal(await priorDeployment(makeApi('stage-all'), '260', undefined, 'staging'), null)
  // Production never reads stage-all logs or resets its baseline on stage-all.
  let readLog = false
  const prodApi = async path => {
    if (path.endsWith('/jobs/9001/logs')) { readLog = true; return receiptLine('stage-all') }
    return makeApi('stage-all')(path)
  }
  assert.equal(await priorDeployment(prodApi, '260', undefined, 'production'), null)
  assert.equal(readLog, false)
  // Non-stage-all deploy-application phases (for example stage-verify or production-web) keep scanning past.
  let scannedOlder = false
  const otherPhaseApi = async path => {
    if (path.includes('/runs/240/attempts/1/jobs?')) { scannedOlder = true }
    return makeApi('stage-verify')(path)
  }
  assert.equal(await priorDeployment(otherPhaseApi, '260', undefined, 'staging'), null)
  assert.equal(scannedOlder, true)
})

test('selection failures report their pipeline code even when assert appends a diff', () => {
  const failure = (() => { try { baselineOrigin({ version: 1, target: 'staging', status: 'failed' }) } catch (error) { return error } })()
  assert.equal(selectionError(failure), 'pipeline_previous_release_requires_recovery')
  assert.equal(selectionError(new Error('pipeline_github_request_failed')), 'pipeline_github_request_failed')
  assert.equal(selectionError(new Error('The expression evaluated to a falsy value')), 'pipeline_selection_failed')
  assert.equal(selectionError('pipeline_not_an_error'), 'pipeline_selection_failed')
})

function zipped(files) {
  return execFileSync('python3', ['-c',
    'import io,json,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w") as z:\n for name,value in json.loads(sys.argv[1]).items(): z.writestr(name,json.dumps(value))\nsys.stdout.buffer.write(b.getvalue())', JSON.stringify(files)])
}

// A paused production: the owner dispatches pipeline-promote naming staging run 199 and its commit.
async function manualPromotion(t, change = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-manual-promotion-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const deploy = '.github/workflows/cloudflare-app-deploy.yml'
  const bot = { id: 118344674, login: 'github-merge-queue[bot]' }
  const env = { GITHUB_REPOSITORY: repo.full_name, GITHUB_REPOSITORY_ID: String(repo.id), GITHUB_REPOSITORY_OWNER_ID: '183887963',
    GITHUB_REF: 'refs/heads/main', GITHUB_ACTOR_ID: '183887963', GITHUB_ACTOR: 'alexj11324', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_ENV: join(directory, 'env'), RUNNER_TEMP: directory, GITHUB_RUN_ID: '201', GITHUB_RUN_ATTEMPT: '1',
    MIKKA_DEPLOYMENT_PHASE: 'pipeline-promote', INPUT_PIPELINE_RUN: '199', INPUT_PROMOTE_SOURCE: source,
    INPUT_CLOUD_SOURCE: 'f'.repeat(40), GITHUB_SHA: 'e'.repeat(40), GITHUB_WORKFLOW_SHA: 'e'.repeat(40),
    GITHUB_WORKFLOW_REF: repo.full_name + '/.github/workflows/cloudflare-app-deploy.yml@refs/heads/main', ...change.env }
  if (!('GITHUB_TRIGGERING_ACTOR' in env)) env.GITHUB_TRIGGERING_ACTOR = change.triggeringActor?.login ?? env.GITHUB_ACTOR
  await writeFile(env.GITHUB_ENV, '')
  const manifest = manifestFixture()
  const stageRun = { ...run(), id: 199, run_attempt: 1, path: deploy, event: 'workflow_run', actor: bot, triggering_actor: bot, ...change.stageRun }
  const dispatcher = change.dispatcher ?? { id: Number(env.GITHUB_ACTOR_ID), login: env.GITHUB_ACTOR }
  const current = { ...run(), id: 201, run_attempt: 1, path: deploy, event: 'workflow_dispatch', status: 'in_progress', conclusion: null,
    head_sha: 'e'.repeat(40), actor: dispatcher, triggering_actor: change.triggeringActor ?? dispatcher, ...change.current }
  const policy = change.policy ?? { version: 1, autoProduction: false, mobileProduction: false,
    promoters: [{ id: 183887963, login: 'alexj11324', note: 'owner' }, { id: 158243242, login: 'devin-ai-integration[bot]', note: 'Devin' }],
    requiredChecks: { production: change.productionChecks ?? [], desktop: [], mobile: [] } }
  const policyBytes = Buffer.from(typeof policy === 'string' ? policy : JSON.stringify(policy))
  const policyRecord = { type: 'file', path: 'docs/operations/releases/deploy-pipeline.json', encoding: 'base64', size: policyBytes.length,
    content: policyBytes.toString('base64'), sha: createHash('sha1').update('blob ' + policyBytes.length + '\0').update(policyBytes).digest('hex') }
  const qualified = { ...run(), id: 501, run_attempt: 1, path: '.github/workflows/cloud-services-ci.yml', event: 'workflow_dispatch' }
  const packet = (origin, id, prefix, files, sha = source) => {
    const bytes = zipped(files)
    return { bytes, artifact: { id, name: `${prefix}-${origin.id}-${origin.run_attempt}`, expired: false, size_in_bytes: bytes.length,
      digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), workflow_run: {
        id: origin.id, head_sha: sha, head_branch: 'main', repository_id: repo.id, head_repository_id: repo.id } } }
  }
  const summary = { version: 1, target: 'staging', status: 'passed', productionPromoted: false, verification: { status: 'pass' },
    deployment: { runId: '199', runAttempt: '1' },
    origin: { source, runId: '101', runAttempt: '2', artifactId: '301', event: 'push', archiveSha256: 'e'.repeat(64) }, ...change.summary }
  const packets = { 101: packet(run(), 301, 'release-manifest', { 'release-manifest.json': manifest }),
    199: packet(stageRun, 401, 'deploy-pipeline', { 'release-manifest.json': change.stagedManifest ?? manifest, 'pipeline-summary.json': summary }),
    501: packet(qualified, 601, 'cloud-services-ci-receipt', { 'receipt.json': {} }) }
  // The serving production baseline: an earlier automatic promotion of an older commit.
  const older = 'c'.repeat(40)
  const oldRelease = { ...run(), id: 90, run_attempt: 1, head_sha: older }
  const production = { ...run(), id: 150, run_attempt: 1, path: deploy, event: 'workflow_run', head_sha: older }
  packets[90] = packet(oldRelease, 290, 'release-manifest', { 'release-manifest.json': manifestFixture(older) }, older)
  packets[150] = packet(production, 450, 'deploy-production', { 'release-manifest.json': manifestFixture(older), 'pipeline-summary.json': {
    version: 1, target: 'production', status: 'passed', verification: { status: 'pass' }, deployment: { runId: '150', runAttempt: '1' },
    origin: { runId: '90', runAttempt: '1', artifactId: '290' } } }, older)
  // A later staging writer: a pipeline-rollback dispatch that restored the previous staging release.
  const newer = { ...run(), id: 200, run_attempt: 1, path: deploy, event: 'workflow_dispatch' }
  packets[200] = packet(newer, 402, 'deploy-pipeline', { 'release-manifest.json': manifest, 'pipeline-summary.json': {
    version: 1, target: 'staging', status: 'passed', verification: { status: 'pass' }, deployment: { runId: '200', runAttempt: '1' },
    rollback: { status: 'passed' }, origin: summary.origin, previousOrigin: summary.origin } })
  const stageJobs = change.stageJobs ?? [{ id: 7199, name: 'pipeline', status: 'completed', conclusion: 'success', steps: [
    { name: 'Deploy and verify staged service manifest', status: 'completed', conclusion: 'success' },
    { name: 'Upload pipeline receipts', status: 'completed', conclusion: 'success' }] },
    { name: 'pipeline-production', status: 'completed', conclusion: 'skipped' }]
  const calls = []
  const api = async path => {
    calls.push(path)
    if (path.endsWith('/runs/101/attempts/2')) return run()
    if (path.endsWith('/runs/201/attempts/1')) return current
    if (path === 'alexj11324/mikka-cloud/contents/docs/operations/releases/deploy-pipeline.json?ref=' + 'f'.repeat(40)) return policyRecord
    if (path.endsWith(`/contents/packages/protocol/src/device.ts?ref=${source}`))
      return { encoding: 'base64', content: Buffer.from(`export const MIN_DAEMON_VERSION = '${change.daemonFloor ?? '0.0.456'}'\n`).toString('base64') }
    if (path.includes(`/commits/${source}/check-runs?`)) return { total_count: 1, check_runs: change.checkRuns ?? [] }
    if (path.endsWith('/actions/runs/601')) return { id: 601, path: '.github/workflows/browser-gate.yml', head_sha: source, head_branch: 'main', status: 'completed',
      conclusion: 'success', event: 'push', repository: { id: 1427517699 }, head_repository: { id: 1427517699 } }
    if (path.endsWith('/actions/jobs/1')) return { id: 1, run_id: 601, name: 'Browser e2e', head_sha: source, status: 'completed', conclusion: 'success' }
    if (path.endsWith('/runs/90/attempts/1')) return oldRelease
    if (path.endsWith('/actions/runs/199')) return stageRun
    if (path.includes('/runs/199/attempts/1/jobs?')) return { total_count: stageJobs.length, jobs: stageJobs }
    for (const [id, value] of Object.entries(packets)) {
      if (path.includes(`/runs/${id}/artifacts?`)) return { total_count: 1, artifacts: [value.artifact] }
      if (path.endsWith(`/artifacts/${value.artifact.id}/zip`)) return value.bytes
    }
    if (path.endsWith('mikka-cloud/git/ref/heads/main')) return { object: { sha: 'f'.repeat(40) } }
    if (path.includes('workflows/cloudflare-app-deploy.yml/runs?')) {
      const runs = [current, ...(change.newerStaging ? [newer] : []), stageRun, ...(change.production ? [production] : [])]
      return { total_count: runs.length, workflow_runs: runs }
    }
    if (path.endsWith('/jobs/7199/logs')) return Buffer.from('Artifact deploy-pipeline-199-1.zip successfully finalized.\nArtifact ID 401\n')
    if (path.includes('/runs/200/attempts/1/jobs?')) return { total_count: 1, jobs: [{ id: 7200, name: 'pipeline', status: 'completed', conclusion: 'success',
      steps: [{ name: 'Deploy and verify staged service manifest', conclusion: 'success' }] }] }
    if (path.endsWith('/jobs/7200/logs')) return Buffer.from('Artifact deploy-pipeline-200-1.zip successfully finalized.\nArtifact ID 402\n')
    if (path.includes('/runs/150/attempts/1/jobs?')) return { total_count: 1, jobs: [{ id: 7150, name: 'pipeline-production', status: 'completed',
      conclusion: 'success', steps: [{ name: 'Promote and verify the staged service manifest', conclusion: 'success' }] }] }
    if (path.endsWith('/jobs/7150/logs')) return Buffer.from('Artifact deploy-production-150-1.zip successfully finalized.\nArtifact ID 450\n')
    if (path.endsWith(`/compare/${older}...${source}`)) return { status: change.compare ?? 'ahead' }
    if (path.includes('workflows/cloud-services-ci.yml/runs?')) return { total_count: 1, workflow_runs: [qualified] }
    assert.fail('Unexpected manual promotion request: ' + path)
  }
  return { env, api, calls, read: () => readFile(env.GITHUB_ENV, 'utf8'), npmLatest: async () => ('npmLatest' in change ? change.npmLatest : '0.0.500') }
}

test('a paused production promotes only the staging run and commit a listed promoter names in a dispatch', async t => {
  for (const production of [false, true]) {
    const f = await manualPromotion(t, { production })
    const result = await selectPromotion({ env: f.env, api: f.api, npmLatest: f.npmLatest })
    assert.deepEqual(result, { status: 'selected', source, operations: 'f'.repeat(40), report: join(f.env.RUNNER_TEMP, 'deploy-production') })
    const variables = Object.fromEntries((await f.read()).trim().split('\n').map(line => line.split('=')))
    assert.equal(variables.MIKKA_STAGE_RUN_ID, '199')
    assert.equal(variables.MIKKA_STAGE_RUN_ATTEMPT, '1')
    assert.equal(variables.MIKKA_STAGE_ARTIFACT_ID, '401')
    assert.equal(variables.MIKKA_RELEASE_RUN_ID, '101')
    assert.equal(variables.MIKKA_CF_OPERATIONS_SHA, 'f'.repeat(40))
    assert.equal(variables.MIKKA_PRODUCTION_RELEASE_RUN_ID, production ? '90' : undefined)
    assert.equal(f.calls.some(path => path.includes('/compare/')), production)
  }
  // An agent on the promoters list promotes exactly like the owner; a required production check must pass.
  const devin = { GITHUB_ACTOR_ID: '158243242', GITHUB_ACTOR: 'devin-ai-integration[bot]' }
  const agent = await manualPromotion(t, { env: devin })
  assert.equal((await selectPromotion({ env: agent.env, api: agent.api, npmLatest: agent.npmLatest })).status, 'selected')
  const e2e = { name: 'browser-e2e', kind: 'check-run', repository: 'public', checkRun: 'Browser e2e', workflow: '.github/workflows/browser-gate.yml' }
  const passed = await manualPromotion(t, { productionChecks: [e2e], checkRuns: [{ name: 'Browser e2e', head_sha: source, status: 'completed',
    conclusion: 'success', app: { id: 15368 }, details_url: 'https://github.com/alexj11324/Mikka/actions/runs/601/job/1' }] })
  assert.equal((await selectPromotion({ env: passed.env, api: passed.api, npmLatest: passed.npmLatest })).status, 'selected')
})

test('a manual promotion refuses other actors, missing or mismatched inputs, unfinished staging and downgrades', async t => {
  const untrusted = async () => assert.fail('An untrusted dispatch must not read GitHub')
  for (const [env, code] of [
    [{ GITHUB_ACTOR_ID: '118344674', GITHUB_ACTOR: 'github-merge-queue[bot]' }, /pipeline_actor_untrusted/],
    [{ GITHUB_ACTOR_ID: '41898282', GITHUB_ACTOR: 'github-actions[bot]' }, /pipeline_actor_untrusted/],
    [{ GITHUB_WORKFLOW_REF: repo.full_name + '/.github/workflows/cloudflare-app-deploy.yml@refs/heads/feature' }, /pipeline_workflow_ref_required/],
    [{ GITHUB_WORKFLOW_SHA: 'd'.repeat(40) }, /pipeline_workflow_ref_required/],
    [{ MIKKA_DEPLOYMENT_PHASE: 'pipeline-stage' }, /pipeline_deployment_phase_invalid/],
    [{ INPUT_PIPELINE_RUN: '' }, /pipeline_promotion_stage_run_required/],
    [{ INPUT_PIPELINE_RUN: '201' }, /pipeline_promotion_stage_run_required/],
    [{ INPUT_PROMOTE_SOURCE: '' }, /pipeline_promotion_source_required/],
    [{ GITHUB_EVENT_NAME: 'push' }, /pipeline_workflow_run_event_required/],
  ]) {
    const f = await manualPromotion(t, { env })
    await assert.rejects(selectPromotion({ env: f.env, api: untrusted }), code, JSON.stringify(env))
  }
  const failedJob = [{ name: 'pipeline', status: 'completed', conclusion: 'failure', steps: [] }]
  const rolledBack = { rollback: { status: 'passed' } }
  for (const [change, code] of [
    [{ env: { INPUT_PROMOTE_SOURCE: 'd'.repeat(40) } }, /pipeline_promotion_source_mismatch/],
    [{ env: { INPUT_CLOUD_SOURCE: 'e'.repeat(40) } }, /pipeline_operations_source_must_be_current_main/],
    [{ stageRun: { event: 'workflow_dispatch' } }, /pipeline_run_event_mismatch/],
    [{ stageRun: { conclusion: 'failure' } }, /pipeline_run_unsuccessful/],
    [{ stageRun: { actor: { id: 7, login: 'outsider' } } }, /pipeline_run_actor_untrusted/],
    [{ stageJobs: failedJob }, /pipeline_stage_incomplete/],
    [{ summary: rolledBack }, /pipeline_stage_rollback_rejected/],
    [{ summary: { status: 'failed' } }, /pipeline_stage_incomplete/],
    [{ summary: { target: 'production' } }, /pipeline_stage_target_mismatch/],
    [{ summary: { verification: { status: 'fail' } } }, /pipeline_summary_verification_required/],
    [{ summary: { deployment: { runId: '198', runAttempt: '1' } } }, /pipeline_deployment_summary_run_mismatch/],
    [{ stagedManifest: manifestFixture('d'.repeat(40)) }, /pipeline_stage_manifest_mismatch/],
    [{ production: true, compare: 'behind' }, /pipeline_promotion_downgrade_rejected/],
    [{ production: true, compare: 'diverged' }, /pipeline_promotion_downgrade_rejected/],
    // A candidate whose daemon floor is above npm latest would refuse every installed daemon.
    [{ daemonFloor: '0.0.501' }, /pipeline_daemon_latest_behind/],
    [{ npmLatest: undefined, daemonFloor: '0.0.1' }, /pipeline_daemon_latest_behind/],
    [{ daemonFloor: 'next' }, /pipeline_daemon_floor_unreadable/],
    // A rollback (or any later staging run) since the candidate staged makes it no longer promotable.
    [{ newerStaging: true }, /pipeline_stage_not_current/],
    [{ triggeringActor: { id: 158243242, login: 'devin-ai-integration[bot]' }, env: { GITHUB_TRIGGERING_ACTOR: 'alexj11324' } }, /pipeline_run_identity_mismatch/],
    [{ policy: { version: 1, autoProduction: false, mobileProduction: false, promoters: [{ id: 183887963, login: 'alexj11324', note: 'owner' }],
      requiredChecks: { production: [], desktop: [], mobile: [] } } }, /pipeline_promoters_diverged/],
    // Gate on the promoters list and the run's real identity, including a re-run by someone else.
    [{ env: { GITHUB_ACTOR_ID: '7', GITHUB_ACTOR: 'outsider' } }, /pipeline_actor_not_promoter/],
    [{ triggeringActor: { id: 7, login: 'outsider' } }, /pipeline_actor_not_promoter/],
    [{ env: { GITHUB_ACTOR: 'renamed' } }, /pipeline_actor_not_promoter/],
    [{ current: { actor: { id: 158243242, login: 'devin-ai-integration[bot]' } } }, /pipeline_run_identity_mismatch/],
    [{ current: { head_branch: 'feature' } }, /pipeline_run_identity_mismatch/],
    [{ current: { path: '.github/workflows/other.yml' } }, /pipeline_run_identity_mismatch/],
    [{ policy: { version: 1, autoProduction: false, mobileProduction: false, promoters: [], requiredChecks: { production: [], desktop: [], mobile: [] } } }, /pipeline_actor_not_promoter/],
    [{ policy: { version: 1, autoProduction: false, mobileProduction: false, requiredChecks: { production: [], desktop: [], mobile: [] } } }, /pipeline_policy_unreadable/],
    [{ policy: '{not json' }, /pipeline_policy_unreadable/],
    [{ productionChecks: [{ name: 'browser-e2e', kind: 'check-run', repository: 'public', checkRun: 'Browser e2e', workflow: '.github/workflows/browser-gate.yml' }],
      checkRuns: [{ name: 'Browser e2e', head_sha: source, status: 'completed', conclusion: 'failure' }] }, /pipeline_required_check_failed/],
    [{ productionChecks: [{ name: 'mobile-smoke', kind: 'builtin' }] }, /pipeline_required_check_failed/],
  ]) {
    const f = await manualPromotion(t, change)
    await assert.rejects(selectPromotion({ env: f.env, api: f.api, npmLatest: f.npmLatest }), code, JSON.stringify(change))
    assert.equal(await f.read(), '', 'A refused promotion exports nothing to later steps')
  }
})
