import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
const require = createRequire(import.meta.url)
const yaml = require('js-yaml')
const source = await readFile(new URL('../../.github/workflows/cloudflare-app-deploy.yml', import.meta.url), 'utf8')
const workflow = yaml.load(source)

test('main build completion uses a non-cancelling shared deployment queue and preserves manual phases', () => {
  assert.deepEqual(workflow.on.workflow_run, { workflows: ['Cloudflare API image'], types: ['completed'], branches: ['main'] })
  assert.deepEqual(workflow.concurrency, { group: 'cloudflare-application-deployment', queue: 'max', 'cancel-in-progress': false })
  const phases = workflow.on.workflow_dispatch.inputs.phase.options
  for (const phase of ['production-migrate-database', 'gateway-observe', 'service-production', 'pipeline-stage', 'pipeline-rollback'])
    assert.ok(phases.includes(phase))
  assert.match(workflow.jobs['deploy-application'].if, /workflow_dispatch/)
  assert.match(workflow.jobs['deploy-application'].if, /!startsWith\(inputs.phase, 'pipeline-'\)/)
  assert.equal(workflow.jobs['deploy-application'].concurrency, undefined)
})

test('only actual successful same-repository main pushes or explicit recovery acquire staging credentials', () => {
  const job = workflow.jobs.pipeline
  for (const required of ["github.repository_id == '1427517699'", "github.ref == 'refs/heads/main'",
    "github.event_name == 'workflow_run'", "github.event.workflow_run.event == 'push'", "github.event.workflow_run.conclusion == 'success'",
    'github.event.workflow_run.head_repository.id == github.event.repository.id']) assert.ok(job.if.includes(required))
  assert.equal(job.environment, 'cloudflare-runtime-release')
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read', issues: 'read', 'id-token': 'write' })
  const select = job.steps.find(step => step.id === 'select')
  assert.equal(select.run, 'node scripts/release/pipeline-inputs.mjs')
  const token = job.steps.find(step => step.name === 'Read the existing Cloudflare deployment identity')
  assert.equal(token.if, "steps.select.outputs.status == 'selected'")
  const apply = job.steps.find(step => step.name === 'Deploy and verify staged service manifest')
  assert.equal(apply.run, 'node operations/public-release.mjs')
  assert.equal(apply['working-directory'], 'operations')
  assert.equal(apply.if, "steps.select.outputs.status == 'selected'")
  assert.doesNotMatch(source, /GITHUB_EVENT_NAME:\s|GITHUB_REF:\s|GITHUB_ACTOR_ID:\s/)
})

test('automatic staging accepts the merge queue pair but manual recovery remains owner-only', () => {
  const allowed = new Function('github', 'inputs', `return ${workflow.jobs.pipeline.if}`)
  const github = { repository_id: '1427517699', repository_owner_id: '359279274', ref: 'refs/heads/main',
    actor_id: '118344674', actor: 'github-merge-queue[bot]', triggering_actor: 'github-merge-queue[bot]', event_name: 'workflow_run', event: {
      repository: { id: 1427517699 }, workflow_run: { event: 'push', head_branch: 'main', conclusion: 'success', head_repository: { id: 1427517699 } } } }
  assert.equal(allowed(github, {}), true)
  assert.equal(allowed({ ...github, triggering_actor: 'alexj11324' }, {}), true)
  assert.equal(allowed({ ...github, actor_id: '183887963', actor: 'alexj11324' }, {}), true)
  for (const patch of [{ actor_id: '7' }, { actor: 'outsider' }, { actor_id: undefined }, { triggering_actor: 'outsider' },
    { ref: 'refs/heads/feature' }, { repository_id: '7' }, { repository_owner_id: '7' }])
    assert.equal(allowed({ ...github, ...patch }, {}), false)
  for (const patch of [{ event: 'workflow_dispatch' }, { head_branch: 'feature' }, { conclusion: 'failure' }, { head_repository: { id: 7 } }])
    assert.equal(allowed({ ...github, event: { ...github.event, workflow_run: { ...github.event.workflow_run, ...patch } } }, {}), false)
  for (const phase of ['pipeline-stage', 'pipeline-rollback']) {
    assert.equal(allowed({ ...github, event_name: 'workflow_dispatch' }, { phase }), true)
    assert.equal(allowed({ ...github, actor_id: '158243242', actor: 'devin-ai-integration[bot]', event_name: 'workflow_dispatch' }, { phase }), true)
    assert.equal(allowed({ ...github, event_name: 'workflow_dispatch' }, { phase: 'stage-all' }), false)
  }
})

test('public records cannot receive the private rollback receipt or runtime credentials', () => {
  const upload = workflow.jobs.pipeline.steps.find(step => step.name === 'Upload pipeline receipts')
  assert.equal(upload.with.name, 'deploy-pipeline-${{ github.run_id }}-${{ github.run_attempt }}')
  assert.equal(upload.with['if-no-files-found'], 'error')
  assert.deepEqual(upload.with.path.trim().split('\n'), [
    '${{ runner.temp }}/deploy-pipeline/release-manifest.json',
    '${{ runner.temp }}/deploy-pipeline/previous-manifest.json',
    '${{ runner.temp }}/deploy-pipeline/pipeline-summary.json',
  ])
  const record = workflow.jobs['pipeline-record']
  assert.deepEqual(record.permissions, { contents: 'read', actions: 'read', deployments: 'write', issues: 'write' })
  assert.equal(record.needs, 'pipeline')
  assert.doesNotMatch(JSON.stringify(record), /Infisical|HOSTED_UI|CLOUDFLARE_API_TOKEN|source-token|overlay-token|MIKKA_OVERLAY_READ_TOKEN|id-token|private\.json/)
  for (const [jobName, target, path] of [['pipeline-record', 'staging', 'pipeline-report'], ['pipeline-production-record', 'production', 'production-report']]) {
    const steps = workflow.jobs[jobName].steps
    const download = steps.find(step => step.uses?.startsWith('actions/download-artifact@'))
    assert.ok(download.with['artifact-ids'])
    assert.equal(download.with['merge-multiple'], true, 'Artifact IDs must extract the summary at the record reader root')
    assert.equal(download.with.path, path)
    const write = steps.find(step => step.run === 'node scripts/release/pipeline-record.mjs')
    assert.equal(write.env.PIPELINE_TARGET, target)
    assert.match(write.env.PIPELINE_SOURCE, /\|\| github\.sha/, 'Manual selection failures need an authentic main source')
    assert.equal(write.env.PIPELINE_REPORT_DIRECTORY ?? 'pipeline-report', path)
  }
})

test('production waits for verified staging records and its separately reviewed policy', () => {
  const job = workflow.jobs['pipeline-production']
  assert.deepEqual(job.needs, ['pipeline', 'pipeline-record'])
  for (const guard of ["github.event_name == 'workflow_run'", "needs.pipeline.result == 'success'",
    "needs.pipeline-record.result == 'success'", "needs.pipeline.outputs.production-enabled == 'true'"]) assert.ok(job.if.includes(guard))
  assert.equal(job.environment, 'cloudflare-runtime-release')
  assert.equal(job.env.MIKKA_DEPLOYMENT_PHASE, 'pipeline-promote')
  assert.equal(job.steps.find(step => step.id === 'select').run, 'node scripts/release/pipeline-inputs.mjs promote')
  const upload = job.steps.find(step => step.name === 'Upload production receipts')
  assert.equal(upload.with.name, 'deploy-production-${{ github.run_id }}-${{ github.run_attempt }}')
  assert.ok(upload.with.path.trim().split('\n').every(path => path.startsWith('${{ runner.temp }}/deploy-production/')))
  assert.doesNotMatch(JSON.stringify(workflow.jobs['pipeline-production-record']), /Infisical|HOSTED_UI|CLOUDFLARE_API_TOKEN|source-token|overlay-token|MIKKA_OVERLAY_READ_TOKEN|id-token|private\.json/)
})

test('failure exercise is an explicit manual staging input and never a production input', () => {
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.staging_failure_drill, {
    description: 'Staging-only acceptance exercise that must fail the real route registration probe',
    type: 'choice', options: ['none', 'route-404'], default: 'none', required: false,
  })
  assert.match(workflow.jobs.pipeline.env.MIKKA_STAGING_FAILURE_DRILL, /github.event_name == 'workflow_dispatch'/)
  assert.equal(workflow.jobs['pipeline-production'].env.MIKKA_STAGING_FAILURE_DRILL, undefined)
  assert.equal(workflow.jobs['deploy-application'].env.MIKKA_STAGING_FAILURE_DRILL, undefined)
})

test('read-only migration admission precedes candidate preparation and deployment credentials for both targets', () => {
  const command = 'node operations/business-api/pipeline-preflight.mjs'
  const expectedToken = '${{ steps.source-token.outputs.token }}'
  const expectedOverlayToken = '${{ steps.overlay-token.outputs.token }}'
  for (const [name, applyName, uploadName] of [
    ['pipeline', 'Deploy and verify staged service manifest', 'Upload pipeline receipts'],
    ['pipeline-production', 'Promote and verify the staged service manifest', 'Upload production receipts'],
  ]) {
    const job = workflow.jobs[name]
    const overlayMint = job.steps.find(step => step.id === 'overlay-token')
    assert.ok(overlayMint, name + ' requires a scoped read-only overlay verification token')
    assert.equal(overlayMint.uses, 'actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349')
    assert.equal(overlayMint.with.repositories, 'mikka-hosted-ui')
    assert.equal(overlayMint.with['permission-contents'], 'read')
    assert.equal(overlayMint.with['permission-actions'], 'read')
    assert.equal(overlayMint.with['permission-checks'], 'read')
    const clearStep = job.steps.findIndex(step => step.name === 'Remove App credentials before loading private operations code')
    assert.ok(clearStep > job.steps.indexOf(overlayMint), name + ' must clear App credentials after minting overlay token')
    const admissions = job.steps.filter(step => step.run === command)
    assert.equal(admissions.length, 1, name + ' requires one independent admission step')
    const admission = admissions[0]
    const index = job.steps.indexOf(admission)
    assert.equal(admission['working-directory'], 'operations')
    assert.equal(admission.if, "steps.select.outputs.status == 'selected'")
    assert.deepEqual(admission.env, {
      GH_TOKEN: expectedToken,
      MIKKA_OVERLAY_READ_TOKEN: expectedOverlayToken,
      MIKKA_PUBLIC_ACTIONS_TOKEN: '${{ github.token }}',
    })
    assert.equal(admission['continue-on-error'], undefined)
    assert.equal(workflow.env?.CLOUDFLARE_API_TOKEN, undefined)
    assert.equal(job.env?.CLOUDFLARE_API_TOKEN, undefined)
    const tools = job.steps.findIndex(step => step.name === 'Install deployment tools without rebuilding the product')
    assert.ok(tools >= 0 && tools < index, 'admission only needs installed private tools')
    assert.doesNotMatch(JSON.stringify(job.steps.slice(0, index + 1)), /CLOUDFLARE_API_TOKEN/)
    assert.equal(job.steps.slice(0, index).some(step => step.run && step['working-directory'] === 'operations/product'), false)
    for (const stepName of ['Install pinned product client and verification dependencies', 'Prepare Ubuntu package mirrors',
      'Install immutable image inspection tools', 'Read the existing Cloudflare deployment identity', applyName]) {
      const later = job.steps.findIndex(step => step.name === stepName)
      assert.ok(later > index, stepName + ' must wait for admission')
      assert.equal(job.steps[later].if, "steps.select.outputs.status == 'selected'", 'the default success condition must stop later work')
      assert.equal(job.steps[later]['continue-on-error'], undefined)
    }
    const applyStep = job.steps.find(step => step.name === applyName)
    assert.deepEqual(applyStep.env, {
      GH_TOKEN: expectedToken,
      MIKKA_OVERLAY_READ_TOKEN: expectedOverlayToken,
      MIKKA_PUBLIC_ACTIONS_TOKEN: '${{ github.token }}',
    })
    const upload = job.steps.find(step => step.name === uploadName)
    assert.equal(upload.if, "always() && steps.select.outputs.status == 'selected'", 'a rejection must retain safe evidence')
  }
  assert.equal(workflow.jobs['deploy-application'].steps.some(step => step.run === command), false)
})

// GitHub expression subset used by these job conditions, evaluated with JavaScript semantics.
function condition(expression) {
  const body = expression.replace(/\.([A-Za-z_][A-Za-z0-9_]*-[A-Za-z0-9_-]+)/g, '["$1"]')
  return new Function('github', 'inputs', 'needs', 'cancelled', 'always', 'startsWith', `return ${body}`)
}
const evaluate = (expression, { github, inputs = {}, needs = {} }) => condition(expression)(github, inputs, needs,
  () => false, () => true, (value, prefix) => String(value ?? '').startsWith(prefix))

// Runs the workflow's own inline policy reader against a fixture operations checkout.
async function policyDecision(policy) {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-production-policy-'))
  try {
    if (policy !== undefined) {
      await mkdir(join(directory, 'docs/operations/releases'), { recursive: true })
      await writeFile(join(directory, 'docs/operations/releases/deploy-pipeline.json'), typeof policy === 'string' ? policy : JSON.stringify(policy))
    }
    const step = workflow.jobs.pipeline.steps.find(item => item.id === 'policy')
    const script = /<<'JS'\n([\s\S]*)\nJS\s*$/.exec(step.run)[1]
    const output = join(directory, 'output')
    await writeFile(output, '')
    execFileSync(process.execPath, ['--input-type=module'], { cwd: directory, input: script,
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: output }, stdio: ['pipe', 'pipe', 'pipe'] })
    return /^enabled=(true|false)$/m.exec(await readFile(output, 'utf8'))[1]
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test('the private autoProduction switch in manual mode leaves production to an owner dispatch only', async () => {
  // The policy reader fails closed without failing staging: only an exact true enables automatic promotion.
  assert.equal(await policyDecision({ version: 1, autoProduction: true, mobileProduction: true }), 'true')
  for (const policy of [{ version: 1, autoProduction: false, mobileProduction: true }, { version: 1 }, { version: 2, autoProduction: true },
    { version: 1, autoProduction: 'true' }, '{not json', undefined]) assert.equal(await policyDecision(policy), 'false', JSON.stringify(policy))

  const production = workflow.jobs['pipeline-production'].if
  const bot = { actor_id: '118344674', actor: 'github-merge-queue[bot]', triggering_actor: 'github-merge-queue[bot]' }
  const github = { repository_id: '1427517699', repository_owner_id: '359279274', ref: 'refs/heads/main', ...bot,
    event_name: 'workflow_run', event: { repository: { id: 1427517699 },
      workflow_run: { event: 'push', head_branch: 'main', conclusion: 'success', head_repository: { id: 1427517699 } } } }
  const staged = enabled => ({ pipeline: { result: 'success', outputs: { selected: 'selected', 'production-enabled': enabled } },
    'pipeline-record': { result: 'success' } })
  // Automatic promotion after a merge happens only while the switch reads true.
  assert.equal(evaluate(production, { github, needs: staged('true') }), true)
  assert.equal(evaluate(production, { github, needs: staged('false') }), false)
  assert.equal(evaluate(production, { github, needs: staged('') }), false)
  assert.equal(evaluate(production, { github, needs: { ...staged('true'), pipeline: { result: 'failure', outputs: { 'production-enabled': 'true' } } } }), false)
  assert.equal(evaluate(production, { github, needs: { ...staged('true'), 'pipeline-record': { result: 'failure' } } }), false)
  // Staging still runs on every merge regardless of the switch.
  assert.equal(evaluate(workflow.jobs.pipeline.if, { github }), true)

  // The manual path: only the owner's own dispatch of pipeline-promote on main reaches production.
  const skipped = { pipeline: { result: 'skipped', outputs: {} }, 'pipeline-record': { result: 'skipped' } }
  const owner = { ...github, event_name: 'workflow_dispatch', actor_id: '183887963', actor: 'alexj11324', triggering_actor: 'alexj11324' }
  assert.equal(evaluate(production, { github: owner, inputs: { phase: 'pipeline-promote' }, needs: skipped }), true)
  assert.equal(evaluate(workflow.jobs.pipeline.if, { github: owner, inputs: { phase: 'pipeline-promote' } }), false)
  assert.equal(evaluate(workflow.jobs['deploy-application'].if, { github: owner, inputs: { phase: 'pipeline-promote' } }), false)
  for (const phase of ['pipeline-stage', 'pipeline-rollback', 'service-production', 'gateway-observe', undefined])
    assert.equal(evaluate(production, { github: owner, inputs: { phase }, needs: skipped }), false, String(phase))
  for (const patch of [{ actor_id: '118344674', actor: 'github-merge-queue[bot]' }, { actor_id: '158243242', actor: 'devin-ai-integration[bot]' },
    { ref: 'refs/heads/feature' }, { repository_id: '7' }, { repository_owner_id: '7' }])
    assert.equal(evaluate(production, { github: { ...owner, ...patch }, inputs: { phase: 'pipeline-promote' }, needs: skipped }), false, JSON.stringify(patch))
  // The dispatch carries the staging run and the exact commit to promote into the selector.
  assert.ok(workflow.on.workflow_dispatch.inputs.phase.options.includes('pipeline-promote'))
  assert.equal(workflow.on.workflow_dispatch.inputs.promote_source.type, 'string')
  const select = workflow.jobs['pipeline-production'].steps.find(step => step.id === 'select')
  assert.equal(select.env.INPUT_PIPELINE_RUN, '${{ inputs.pipeline_run }}')
  assert.equal(select.env.INPUT_PROMOTE_SOURCE, '${{ inputs.promote_source }}')
  assert.equal(select.env.INPUT_CLOUD_SOURCE, '${{ inputs.cloud_source_sha }}')
})
