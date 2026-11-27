import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import yaml from 'js-yaml'
import { inspectAcceptance } from './pr-acceptance-check.mjs'
import {
  buildIsolatedDockerArgs,
  buildMinimalProbeEnv,
  diffOverlayTypeErrors,
  evaluateAutoSyncPlan,
  evaluatePromotionGate,
  hasPassingUiPolicyCheck,
  parseDeployBuildInputs,
  parseOverlayTypeErrors,
  selectPairingCandidates,
  verifyPairingInWorkspace,
} from './integration-promotion-probe.mjs'

const promotionWorkflow = readFileSync(
  new URL('../../.github/workflows/integration-to-main-promotion.yml', import.meta.url),
  'utf8',
)

const SHA = '1111111111111111111111111111111111111111'
const SHA2 = '2222222222222222222222222222222222222222'
const SHA3 = '3333333333333333333333333333333333333333'

test('no workflow besides the integration promotion enqueues PRs on its own', () => {
  const dir = new URL('../../.github/workflows/', import.meta.url)
  for (const name of readdirSync(dir).filter(file => /\.ya?ml$/.test(file))) {
    if (name === 'integration-to-main-promotion.yml') continue
    assert.doesNotMatch(readFileSync(new URL(name, dir), 'utf8'), /enqueuePullRequest/, `${name} must not enqueue PRs`)
  }
})

test('promotion workflow parses cleanly as YAML with four isolated jobs and strict security boundaries', () => {
  const parsed = yaml.load(promotionWorkflow)
  assert.deepEqual(Object.keys(parsed.on), ['workflow_dispatch'],
    'promotion workflow must be on-demand workflow_dispatch only (no background schedule cron)')
  assert.equal(parsed.on.workflow_dispatch.inputs.dry_run.default, true,
    'workflow_dispatch must fail closed to dry_run=true by default')
  assert.deepEqual(Object.keys(parsed.jobs), ['plan', 'auto-sync', 'verify-overlay-pairing', 'promote'])
  assert.match(parsed.env.PROBE_DOCKER_IMAGE, /^node:24\.22\.1-trixie@sha256:[0-9a-f]{64}$/)

  const planEval = parsed.jobs.plan.steps.find(step => step.id === 'eval')
  assert.ok(planEval)
  assert.match(planEval.run, /dry_run="true"/)
  assert.match(planEval.run, /branches\/\$encoded_branch/)
  assert.match(planEval.run, /sync_pr_includes_base/)
  assert.match(planEval.run, /jq -er '\.draft \| booleans \| tostring'/)
  assert.doesNotMatch(promotionWorkflow, /vars\.MIKKA_INTEGRATION_PROMOTE_TO_MAIN/,
    'legacy MIKKA_INTEGRATION_PROMOTE_TO_MAIN must not bypass overlay compatibility checks')
  for (const draft of [false, true]) {
    const out = execFileSync('jq', ['-er', '.draft | booleans | tostring'], {
      input: JSON.stringify({ draft }),
      encoding: 'utf8',
    }).trim()
    assert.equal(out, String(draft))
  }

  const promoteSteps = parsed.jobs.promote.steps
  const driftStep = promoteSteps.find(step => step.id === 'drift')
  assert.ok(driftStep, 'promote job must re-verify live main and integration tips before writing')
  assert.match(driftStep.run, /live_main.*EXPECTED_MAIN_SHA/)
  assert.match(driftStep.run, /live_head.*EXPECTED_HEAD_SHA/)
  const promoteScript = promoteSteps.map(step => step.run ?? '').join('\n')
  assert.match(promoteScript, /enqueuePullRequest/)
  assert.doesNotMatch(promoteScript, /\bgh pr merge\b/, 'promote job must never bypass main merge_group via gh pr merge')
  assert.ok(promoteSteps.every(step => !step.with?.ref || step.with.ref === '${{ github.sha }}'),
    'promote job may only check out trusted main (github.sha), never integration branch code')

  const syncScript = parsed.jobs['auto-sync'].steps.map(step => step.run ?? '').join('\n')
  assert.match(syncScript, /test "\$BRANCH" != "main"/)
  assert.match(syncScript, /test "\$base_ref" != "main"/)
  assert.match(syncScript, /live_base_sha.*EXPECTED_BASE_SHA/)
  assert.match(syncScript, /replace_sync_pr/)
  assert.match(syncScript, /clean_live_tree=\$\(git rev-parse "\$\{clean_live_merge_sha\}\^\{tree\}"\)/)
  assert.match(syncScript, /forward_tree=\$\(git rev-parse 'HEAD\^\{tree\}'\)/)
  assert.match(syncScript, /tree_mismatch/)
  assert.match(syncScript, /--merge --delete-branch --match-head-commit/)
  assert.doesNotMatch(syncScript, /--force|-f\s+origin/, 'auto-sync must never force-push')

  const probeSteps = parsed.jobs['verify-overlay-pairing'].steps
  const pullIdx = probeSteps.findIndex(step => /Pull digest-pinned sandbox image/i.test(step.name ?? ''))
  const scrubIdx = probeSteps.findIndex(step => /Scrub App credentials/i.test(step.name ?? ''))
  const mirrorIdx = probeSteps.findIndex(step => /Fetch candidate overlay commits into local bare mirror/i.test(step.name ?? ''))
  const installIdx = probeSteps.findIndex(step => /Install public workspace/i.test(step.name ?? ''))
  const probeIdx = probeSteps.findIndex(step => step.id === 'probe')
  const cleanupStep = probeSteps.find(step => step.if === 'always()')
  assert.ok(pullIdx > 0 && scrubIdx > pullIdx && mirrorIdx > scrubIdx && installIdx > mirrorIdx && probeIdx > installIdx)
  assert.ok(cleanupStep && /rm -rf integration\/\.hosted-ui/.test(cleanupStep.run ?? ''))
  assert.match(probeSteps[mirrorIdx].run, /--depth=1 --update-shallow .*\$\{sha\}:refs\/candidates\/\$\{sha\}/)
  assert.match(probeSteps[installIdx].run, /pnpm --dir integration install --frozen-lockfile --ignore-scripts/)
  assert.match(probeSteps[installIdx].run, /pnpm --dir main install --frozen-lockfile --ignore-scripts/)
  assert.match(probeSteps[probeIdx].run, /git init --quiet "\$overlay_dir"/)
  assert.match(probeSteps[probeIdx].run, /fetch --quiet --no-tags --depth=1 --update-shallow "\$RUNNER_TEMP\/overlay-mirror\.git" "refs\/candidates\/\$\{sha\}"/)
  assert.match(probeSteps[probeIdx].run, /test "\$\(git -C "\$overlay_dir" rev-parse HEAD\)" = "\$sha"/)
  assert.match(probeSteps[probeIdx].run, /--prod --ignore-scripts/)
  assert.match(probeSteps[probeIdx].run, /--integration-dir "\$GITHUB_WORKSPACE\/integration"/)
  assert.match(probeSteps[probeIdx].run, /--main-dir "\$GITHUB_WORKSPACE\/main"/)
  assert.match(probeSteps[probeIdx].run, /--docker-image "\$PROBE_DOCKER_IMAGE"/)
})

test('promotion and sync PR bodies keep acceptance pending until CI passes and pass with real evidence', () => {
  const pendingBody = `## Summary
Autonomous scheduled promotion of integration branch \`claude/affectionate-einstein-s235cb\` into \`main\`.

## Acceptance
Commit: ${SHA}
Runtime: both
Model: scripted (at the LiteLLM boundary)
Fixtures: awaiting CI run on this exact promotion head
Items: pending
Evidence: pending
Screenshots: not needed: backend integration promotion`

  const pendingResult = inspectAcceptance({ body: pendingBody, files: [{ filename: 'lib/example.ts' }], draft: false })
  assert.equal(pendingResult.status, 'fail', 'untested head must not produce passing acceptance')
  assert.ok(pendingResult.errors.includes('acceptance.evidence-missing'))

  const verifiedBody = `## Summary
Autonomous scheduled promotion of integration branch \`claude/affectionate-einstein-s235cb\` into \`main\`.

## Acceptance
Commit: ${SHA}
Runtime: both
Model: scripted (at the LiteLLM boundary)
Fixtures: verified on constituent PRs and this exact promotion head
Items: 3/3 passed (UI policy (strict), Production build and browser interactions, Browser tests (before merge))
Evidence: https://github.com/aspectly-labs/Mikka/actions/runs/999999
Screenshots: not needed: backend integration promotion`

  const verifiedResult = inspectAcceptance({ body: verifiedBody, files: [{ filename: 'lib/example.ts' }], draft: false })
  assert.equal(verifiedResult.status, 'pass')
  assert.equal(verifiedResult.mode, 'evidence')

  assert.match(promotionWorkflow, /Items: pending/)
  assert.match(promotionWorkflow, /Evidence: pending/)
  assert.match(promotionWorkflow, /Evidence: \$\{CI_RUN_URL\}/)
  assert.match(promotionWorkflow, /Evidence: \$\{SYNC_PR_CI_RUN_URL\}/)
})

test('parseDeployBuildInputs enforces strict version=1 and 40-char lowercase overlaySource schema', () => {
  assert.deepEqual(
    parseDeployBuildInputs(JSON.stringify({ version: 1, overlaySource: SHA })),
    { version: 1, overlaySource: SHA },
  )
  assert.throws(() => parseDeployBuildInputs('{"version":2,"overlaySource":"' + SHA + '"}'))
  assert.throws(() => parseDeployBuildInputs('{"version":1,"overlaySource":"not-a-sha"}'))
  assert.throws(() => parseDeployBuildInputs('{"version":1,"overlaySource":"' + SHA + '","extra":true}'))
})

test('diffOverlayTypeErrors ignores baseline main errors, catches new breaks, and emits zero private paths', () => {
  const mainOutput = [
    '/tmp/w/.hosted-ui/core/renderer/app.tsx(79,49): error TS2322: pre-existing type mismatch',
    'lib/unrelated.ts(10,1): error TS2304: outside overlay',
  ].join('\n')
  const integrationOutput = [
    '/tmp/w/.hosted-ui/core/renderer/app.tsx(79,49): error TS2322: pre-existing type mismatch',
    '/tmp/w/.hosted-ui/slots/model-picker.tsx(94,128): error TS2339: Property featured does not exist',
    '/tmp/w/.hosted-ui/web/components/workspace/issue-editor.tsx(9,40): error TS2307: Cannot find module',
  ].join('\n')

  assert.equal(parseOverlayTypeErrors(mainOutput).size, 1)
  const delta = diffOverlayTypeErrors(mainOutput, integrationOutput)
  assert.deepEqual(delta, {
    newErrorCount: 2,
    newErrorCodes: ['TS2307', 'TS2339'],
  })
  const serialized = JSON.stringify(delta)
  assert.doesNotMatch(serialized, /model-picker|issue-editor|\.hosted-ui/, 'public output must never leak private UI file paths')
  assert.deepEqual(diffOverlayTypeErrors(mainOutput, mainOutput), {
    newErrorCount: 0,
    newErrorCodes: [],
  })
})

test('evaluateAutoSyncPlan requires sync PR to include BOTH main and current integration base', () => {
  const base = {
    branch: 'claude/affectionate-einstein-s235cb',
    aheadBy: 10,
    behindBy: 3,
    featureChildCount: 0,
    syncPr: null,
    syncPrIncludesMain: false,
    syncPrIncludesBase: false,
    syncPrCiOk: false,
    syncPrCiRunUrl: '',
    syncPrAcceptanceState: 'missing',
    syncPrMergeable: 'UNKNOWN',
  }

  assert.equal(evaluateAutoSyncPlan({ ...base, branch: 'main' }).action, 'noop')
  assert.equal(evaluateAutoSyncPlan({ ...base, aheadBy: 0 }).action, 'noop')
  assert.equal(evaluateAutoSyncPlan({ ...base, behindBy: 0 }).action, 'noop')
  assert.equal(evaluateAutoSyncPlan({ ...base, featureChildCount: 1 }).action, 'noop')
  assert.equal(evaluateAutoSyncPlan(base).action, 'open_sync_pr')

  const syncPr = {
    number: 3400,
    baseRef: 'claude/affectionate-einstein-s235cb',
    headSha: SHA,
    draft: false,
    bodyHasHeadSha: true,
    bodyHasCiRunUrl: true,
  }
  assert.equal(evaluateAutoSyncPlan({
    ...base,
    syncPr,
    syncPrIncludesMain: true,
    syncPrIncludesBase: false,
    syncPrCiOk: true,
    syncPrCiRunUrl: 'https://github.com/aspectly-labs/Mikka/actions/runs/1',
    syncPrAcceptanceState: 'success',
    syncPrMergeable: 'MERGEABLE',
  }).action, 'update_sync_pr')

  assert.equal(evaluateAutoSyncPlan({ ...base, syncPr: { ...syncPr, baseRef: 'main' } }).action, 'noop')
  assert.equal(evaluateAutoSyncPlan({ ...base, behindBy: 0, syncPr }).action, 'close_redundant_sync_pr')
  assert.equal(evaluateAutoSyncPlan({ ...base, syncPr, syncPrIncludesMain: false, syncPrIncludesBase: true }).action, 'update_sync_pr')
  assert.equal(evaluateAutoSyncPlan({
    ...base,
    syncPr: { ...syncPr, bodyHasHeadSha: false, bodyHasCiRunUrl: false },
    syncPrIncludesMain: true,
    syncPrIncludesBase: true,
  }).action, 'reset_sync_acceptance')
  assert.equal(evaluateAutoSyncPlan({
    ...base,
    syncPr: { ...syncPr, bodyHasCiRunUrl: false },
    syncPrIncludesMain: true,
    syncPrIncludesBase: true,
    syncPrCiOk: true,
    syncPrCiRunUrl: 'https://github.com/aspectly-labs/Mikka/actions/runs/1',
  }).action, 'record_sync_evidence')
  assert.equal(evaluateAutoSyncPlan({
    ...base,
    syncPr,
    syncPrIncludesMain: true,
    syncPrIncludesBase: true,
    syncPrCiOk: true,
    syncPrCiRunUrl: 'https://github.com/aspectly-labs/Mikka/actions/runs/1',
    syncPrAcceptanceState: 'success',
    syncPrMergeable: 'MERGEABLE',
  }).action, 'merge_sync_pr')
})

test('selectPairingCandidates prioritizes pinned overlay and adds coordinated Ready UI PR only when UI policy is green', () => {
  assert.deepEqual(
    selectPairingCandidates({ pinnedOverlaySha: SHA, frozenOverlaySha: SHA }),
    [],
    'explicitly frozen overlay SHA must be excluded',
  )
  assert.deepEqual(
    selectPairingCandidates({
      pinnedOverlaySha: SHA,
      hostedUiPr: { number: 390, baseRef: 'main', headSha: SHA2, draft: false },
      hostedUiChildCount: 0,
      hostedUiPolicyOk: true,
    }),
    [
      { mode: 'pinned_overlay', sha: SHA },
      { mode: 'coordinated_ui_pr', sha: SHA2, prNumber: 390 },
    ],
  )
  for (const patch of [
    { hostedUiPr: { number: 390, baseRef: 'main', headSha: SHA2, draft: true } },
    { hostedUiChildCount: 1 },
    { hostedUiPolicyOk: false },
    { hostedUiPr: { number: 390, baseRef: 'other', headSha: SHA2, draft: false } },
  ]) {
    assert.deepEqual(
      selectPairingCandidates({
        pinnedOverlaySha: SHA,
        hostedUiPr: { number: 390, baseRef: 'main', headSha: SHA2, draft: false },
        hostedUiChildCount: 0,
        hostedUiPolicyOk: true,
        ...patch,
      }),
      [{ mode: 'pinned_overlay', sha: SHA }],
    )
  }

  assert.equal(hasPassingUiPolicyCheck([{ name: 'Cloudflare UI Policy', status: 'completed', conclusion: 'success' }]), true)
  assert.equal(hasPassingUiPolicyCheck([{ name: 'Cloudflare UI Policy', status: 'completed', conclusion: 'failure' }]), false)
  assert.equal(hasPassingUiPolicyCheck([{ name: 'Other check', status: 'completed', conclusion: 'success' }]), false)
})

test('evaluatePromotionGate requires approved pinned_overlay by default and formats dry-run notes accurately', () => {
  const common = {
    frozen: false,
    dryRun: false,
    skipOverlayProbe: false,
    allowCoordinatedUnpinned: false,
    plannedAction: 'enqueue_pr',
    plannedReason: 'enqueue promotion PR',
    overlayProbeRan: true,
    overlayCompatible: true,
    overlayMode: 'pinned_overlay',
    overlaySummary: 'pinned_overlay@11111111: compatible=true',
  }

  assert.equal(evaluatePromotionGate({ ...common, frozen: true }).effectiveAction, 'noop')
  assert.equal(evaluatePromotionGate({ ...common, overlayProbeRan: false }).effectiveAction, 'noop')
  assert.equal(evaluatePromotionGate({ ...common, overlayCompatible: false }).effectiveAction, 'noop')
  assert.equal(evaluatePromotionGate({ ...common, dryRun: true }).effectiveAction, 'noop')
  assert.equal(evaluatePromotionGate(common).effectiveAction, 'enqueue_pr')
  assert.equal(evaluatePromotionGate({ ...common, plannedAction: 'create_pr' }).effectiveAction, 'create_pr')

  const coordinatedOnly = evaluatePromotionGate({
    ...common,
    overlayMode: 'coordinated_ui_pr',
    overlaySummary: 'pinned_overlay@11111111: compatible=false; coordinated_ui_pr@22222222: compatible=true',
  })
  assert.equal(coordinatedOnly.effectiveAction, 'noop')
  assert.match(coordinatedOnly.effectiveReason, /readiness evidence only/)

  // Dry-run on record_evidence with coordinated_ui_pr passing and break-glass OFF must NOT claim break-glass authorized.
  const dryEvidence = evaluatePromotionGate({
    ...common,
    dryRun: true,
    plannedAction: 'record_evidence',
    overlayMode: 'coordinated_ui_pr',
    allowCoordinatedUnpinned: false,
  })
  assert.equal(dryEvidence.effectiveAction, 'noop')
  assert.match(dryEvidence.effectiveReason, /probe not required for this step/)
  assert.doesNotMatch(dryEvidence.effectiveReason, /break-glass authorized/)

  assert.equal(
    evaluatePromotionGate({ ...common, overlayMode: 'coordinated_ui_pr', allowCoordinatedUnpinned: true }).effectiveAction,
    'enqueue_pr',
  )
  assert.equal(
    evaluatePromotionGate({ ...common, overlayProbeRan: false, overlayCompatible: false, skipOverlayProbe: true }).effectiveAction,
    'enqueue_pr',
  )
  assert.equal(
    evaluatePromotionGate({ ...common, plannedAction: 'record_evidence', overlayProbeRan: false, overlayCompatible: false }).effectiveAction,
    'record_evidence',
  )
})

test('buildMinimalProbeEnv and buildIsolatedDockerArgs strip GitHub Actions files, tokens, and mount .git read-only', () => {
  const dirty = {
    PATH: '/usr/bin',
    GITHUB_STEP_SUMMARY: '/tmp/summary.md',
    GITHUB_OUTPUT: '/tmp/output.txt',
    GITHUB_ENV: '/tmp/env.txt',
    GITHUB_PATH: '/tmp/path.txt',
    RUNNER_TEMP: '/tmp/runner',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-secret',
    GITHUB_APP_PRIVATE_KEY: 'pem-secret',
    GH_TOKEN: 'gh-secret',
  }
  const clean = buildMinimalProbeEnv(dirty, { MIKKA_UI_OVERLAY_SHA: SHA3 })
  assert.deepEqual(Object.keys(clean).sort(), ['HOME', 'MIKKA_UI_OVERLAY_SHA', 'PATH', 'TMPDIR'])

  const dockerArgs = buildIsolatedDockerArgs({
    dockerImage: 'node:24.22.1-trixie@sha256:f1e034976f948cf212ef1f659c12e5dd58ac7eab947831813e81a62401ca38be',
    workDir: '/work/integration',
    mounts: [
      { source: '/work/integration', target: '/work/integration', readOnly: false },
      { source: '/work/integration/.git', target: '/work/integration/.git', readOnly: true },
      { source: '/work/integration/.hosted-ui/.git', target: '/work/integration/.hosted-ui/.git', readOnly: true },
    ],
    envVars: { HOME: '/tmp', MIKKA_UI_OVERLAY_SHA: SHA3 },
    cmd: ['node', 'apps/frontend/scripts/build.mjs', 'web'],
  })
  assert.ok(dockerArgs.includes('--network') && dockerArgs[dockerArgs.indexOf('--network') + 1] === 'none')
  assert.ok(dockerArgs.includes('--cap-drop') && dockerArgs[dockerArgs.indexOf('--cap-drop') + 1] === 'ALL')
  assert.ok(dockerArgs.includes('no-new-privileges'))
  assert.ok(dockerArgs.includes('/work/integration/.git:/work/integration/.git:ro'))
  assert.ok(dockerArgs.includes('/work/integration/.hosted-ui/.git:/work/integration/.hosted-ui/.git:ro'))
  assert.ok(!dockerArgs.some(arg => /GITHUB_STEP_SUMMARY|GITHUB_OUTPUT|RUNNER_TEMP/.test(arg)))
})

test('verifyPairingInWorkspace runs end-to-end against separate integration/main workspaces with zero private path leakage', () => {
  const root = mkdtempSync(join(tmpdir(), 'mikka-probe-runtime-'))
  try {
    const intDir = join(root, 'integration')
    const mainDir = join(root, 'main')
    const writeFixture = (dir, tsrsErrors) => {
      mkdirSync(join(dir, 'apps/frontend/scripts'), { recursive: true })
      mkdirSync(join(dir, 'apps/frontend/dist/web'), { recursive: true })
      mkdirSync(join(dir, 'lib'), { recursive: true })
      mkdirSync(join(dir, 'scripts/acceptance'), { recursive: true })
      mkdirSync(join(dir, 'scripts/release'), { recursive: true })
      mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true })
      mkdirSync(join(dir, 'node_modules/tsx'), { recursive: true })
      mkdirSync(join(dir, '.hosted-ui'), { recursive: true })
      writeFileSync(join(dir, 'node_modules/tsx/package.json'), '{"name":"tsx","type":"module","exports":"./index.mjs"}\n')
      writeFileSync(join(dir, 'node_modules/tsx/index.mjs'), 'export {}\n')
      writeFileSync(join(dir, '.hosted-ui/tsconfig.json'), '{"compilerOptions":{}}\n')
      writeFileSync(join(dir, 'apps/frontend/scripts/build.mjs'), `
        import { writeFileSync } from 'node:fs'
        if (process.env.GITHUB_STEP_SUMMARY || process.env.GH_TOKEN) process.exit(99)
        writeFileSync('apps/frontend/dist/web/renderer-manifest.json', JSON.stringify({ headless: false, usedActions: ['ping'] }))
      `)
      writeFileSync(join(dir, 'lib/renderer-actions.mjs'), 'export const rendererActionContract = m => ({ usedActions: m.usedActions })\n')
      writeFileSync(join(dir, 'scripts/acceptance/read-action-transport.mjs'), 'export const publishedReadActions = () => true\n')
      writeFileSync(join(dir, 'scripts/release/hosted-ui.mjs'), 'process.exit(0)\n')
      const tsrsPath = join(dir, 'node_modules/.bin/tsrs')
      writeFileSync(tsrsPath, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(tsrsErrors.join('\n'))})\nprocess.exit(${tsrsErrors.length ? 1 : 0})\n`)
      chmodSync(tsrsPath, 0o755)
    }

    const baselineErr = `${join(intDir, '.hosted-ui/core/renderer/app.tsx')}(79,49): error TS2322: pre-existing`
    writeFixture(mainDir, [baselineErr.replace(intDir, mainDir)])
    writeFixture(intDir, [baselineErr])

    const okResult = verifyPairingInWorkspace({
      integrationDir: intDir,
      mainDir,
      overlaySha: SHA,
      mode: 'pinned_overlay',
      env: { ...process.env, GITHUB_STEP_SUMMARY: '/tmp/leak', GH_TOKEN: 'secret' },
    })
    assert.deepEqual(okResult, {
      compatible: true,
      mode: 'pinned_overlay',
      overlayShaShort: SHA.slice(0, 8),
      webBuildOk: true,
      actionContractOk: true,
      auditOk: true,
      newTypeErrorCount: 0,
      newErrorCodes: [],
    })

    // Now add a brand-new integration TS error in a private overlay path and verify fail-closed + zero leakage.
    writeFixture(intDir, [
      baselineErr,
      `${join(intDir, '.hosted-ui/slots/private-secret-surface.tsx')}(94,128): error TS2339: Property featured does not exist`,
    ])
    const failResult = verifyPairingInWorkspace({
      integrationDir: intDir,
      mainDir,
      overlaySha: SHA,
      mode: 'pinned_overlay',
    })
    assert.equal(failResult.compatible, false)
    assert.equal(failResult.newTypeErrorCount, 1)
    assert.deepEqual(failResult.newErrorCodes, ['TS2339'])
    assert.doesNotMatch(JSON.stringify(failResult), /private-secret-surface|\.hosted-ui/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('real Git stale sync-tree scenario merges live tips cleanly when both branches converge on the same fix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mikka-stale-sync-'))
  const git = (...args) => execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'CI',
      GIT_AUTHOR_EMAIL: 'ci@example.invalid',
      GIT_COMMITTER_NAME: 'CI',
      GIT_COMMITTER_EMAIL: 'ci@example.invalid',
    },
  }).trim()
  try {
    git('init', '-b', 'main')
    writeFileSync(join(dir, 'timeout.txt'), '10\n')
    git('add', 'timeout.txt')
    git('commit', '-m', 'base 10')

    git('checkout', '-b', 'integration')
    writeFileSync(join(dir, 'feature.txt'), 'feat\n')
    git('add', 'feature.txt')
    git('commit', '-m', 'integration feature')

    git('checkout', 'main')
    writeFileSync(join(dir, 'timeout.txt'), '20\n')
    git('add', 'timeout.txt')
    git('commit', '-m', 'main 20')

    // Old sync PR merged main@20 into integration@10.
    git('checkout', '-b', 'chore/auto-sync-main-into-integration', 'integration')
    git('merge', '--no-edit', '--no-ff', 'main')

    // Now both main and integration independently move timeout to 30.
    git('checkout', 'main')
    writeFileSync(join(dir, 'timeout.txt'), '30\n')
    git('add', 'timeout.txt')
    git('commit', '-m', 'main 30')
    const mainSha = git('rev-parse', 'HEAD')

    git('checkout', 'integration')
    writeFileSync(join(dir, 'timeout.txt'), '30\n')
    git('add', 'timeout.txt')
    git('commit', '-m', 'integration 30')
    const intSha = git('rev-parse', 'HEAD')

    // Live tips merge cleanly to 30.
    git('checkout', '--detach', intSha)
    git('merge', '--no-edit', '--no-ff', mainSha)
    const cleanLiveTree = git('rev-parse', 'HEAD^{tree}')
    assert.equal(readFileSync(join(dir, 'timeout.txt'), 'utf8'), '30\n')

    // Forward-merging main FIRST, then integration base onto the old sync branch ALSO succeeds cleanly to 30
    // AND produces the exact same tree as the clean live merge.
    git('checkout', 'chore/auto-sync-main-into-integration')
    git('merge', '--no-edit', '--no-ff', mainSha)
    git('merge', '--no-edit', '--no-ff', intSha)
    assert.equal(readFileSync(join(dir, 'timeout.txt'), 'utf8'), '30\n')
    assert.equal(git('rev-parse', 'HEAD^{tree}'), cleanLiveTree)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('real Git sync refresh tree check catches silent divergence from stale sync history and selects clean live merge', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mikka-tree-mismatch-'))
  const git = (...args) => execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'CI',
      GIT_AUTHOR_EMAIL: 'ci@example.invalid',
      GIT_COMMITTER_NAME: 'CI',
      GIT_COMMITTER_EMAIL: 'ci@example.invalid',
    },
  }).trim()
  try {
    git('init', '-b', 'main')
    writeFileSync(join(dir, 'flag.txt'), 'off\n')
    writeFileSync(join(dir, 'timeout.txt'), '10\n')
    git('add', 'flag.txt', 'timeout.txt')
    git('commit', '-m', 'base flag=off timeout=10')

    git('checkout', '-b', 'integration')
    writeFileSync(join(dir, 'flag.txt'), 'on\n')
    git('add', 'flag.txt')
    git('commit', '-m', 'integration flag=on')

    git('checkout', 'main')
    writeFileSync(join(dir, 'flag.txt'), 'on\n')
    writeFileSync(join(dir, 'timeout.txt'), '20\n')
    git('add', 'flag.txt', 'timeout.txt')
    git('commit', '-m', 'main flag=on timeout=20')

    // Stale sync PR merged older main (flag=on, timeout=20) into older integration (flag=on).
    git('checkout', '-b', 'chore/auto-sync-main-into-integration', 'integration')
    git('merge', '--no-edit', '--no-ff', 'main')

    // Main restores timeout=10 (keeping flag=on); integration reverts its flag to off and sets timeout=30.
    git('checkout', 'main')
    writeFileSync(join(dir, 'timeout.txt'), '10\n')
    git('add', 'timeout.txt')
    git('commit', '-m', 'main timeout=10')
    const mainSha = git('rev-parse', 'HEAD')

    git('checkout', 'integration')
    writeFileSync(join(dir, 'flag.txt'), 'off\n')
    writeFileSync(join(dir, 'timeout.txt'), '30\n')
    git('add', 'flag.txt', 'timeout.txt')
    git('commit', '-m', 'integration flag=off timeout=30')
    const intSha = git('rev-parse', 'HEAD')

    // Direct merge of live tips preserves main's flag=on and integration's timeout=30.
    git('checkout', '--detach', intSha)
    git('merge', '--no-edit', '--no-ff', mainSha)
    const cleanLiveMergeSha = git('rev-parse', 'HEAD')
    const cleanLiveTree = git('rev-parse', `${cleanLiveMergeSha}^{tree}`)
    assert.equal(readFileSync(join(dir, 'flag.txt'), 'utf8'), 'on\n')
    assert.equal(readFileSync(join(dir, 'timeout.txt'), 'utf8'), '30\n')

    // Forward-merging onto the stale sync branch completes WITHOUT conflict yet drops main's flag=on!
    git('checkout', 'chore/auto-sync-main-into-integration')
    git('merge', '--no-edit', '--no-ff', mainSha)
    git('merge', '--no-edit', '--no-ff', intSha)
    assert.equal(readFileSync(join(dir, 'flag.txt'), 'utf8'), 'off\n')
    assert.equal(readFileSync(join(dir, 'timeout.txt'), 'utf8'), '30\n')
    const forwardTree = git('rev-parse', 'HEAD^{tree}')
    assert.notEqual(forwardTree, cleanLiveTree, 'stale forward merge silently diverged from direct live merge')

    // Replacing with a branch at cleanLiveMergeSha restores exact live-merge parity.
    git('checkout', '-b', 'chore/auto-sync-main-replacement', cleanLiveMergeSha)
    assert.equal(git('rev-parse', 'HEAD^{tree}'), cleanLiveTree)
    assert.equal(readFileSync(join(dir, 'flag.txt'), 'utf8'), 'on\n')
    assert.equal(readFileSync(join(dir, 'timeout.txt'), 'utf8'), '30\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('real Git shallow bare mirror stages multiple candidate overlay checkouts cleanly for recordOverlay', () => {
  const root = mkdtempSync(join(tmpdir(), 'mikka-shallow-overlay-'))
  const gitEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'CI',
    GIT_AUTHOR_EMAIL: 'ci@example.invalid',
    GIT_COMMITTER_NAME: 'CI',
    GIT_COMMITTER_EMAIL: 'ci@example.invalid',
  }
  const gitAt = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()
  try {
    const src = join(root, 'upstream')
    mkdirSync(src, { recursive: true })
    gitAt(src, 'init', '-b', 'main')
    const commitFile = (name, value) => {
      writeFileSync(join(src, name), value)
      gitAt(src, 'add', name)
      gitAt(src, 'commit', '-m', `${name}=${value}`)
      return gitAt(src, 'rev-parse', 'HEAD')
    }
    const baseSha = commitFile('v.txt', '1\n')
    const pinnedSha = commitFile('v.txt', '2\n')
    gitAt(src, 'checkout', '-b', 'ui-pr', baseSha)
    const prSha = commitFile('v.txt', '3\n')

    const mirror = join(root, 'overlay-mirror.git')
    gitAt(root, 'init', '--bare', mirror)
    for (const sha of [pinnedSha, prSha]) {
      gitAt(mirror, 'fetch', '--quiet', '--no-tags', '--depth=1', '--update-shallow', `file://${src}`, `${sha}:refs/candidates/${sha}`)
    }

    for (const [sha, expectedContent] of [[pinnedSha, '2\n'], [prSha, '3\n']]) {
      const overlayDir = join(root, `overlay-${sha.slice(0, 8)}`)
      gitAt(root, 'init', '--quiet', overlayDir)
      gitAt(overlayDir, '-c', 'core.hooksPath=/dev/null', 'fetch', '--quiet', '--no-tags', '--depth=1', '--update-shallow', mirror, `refs/candidates/${sha}`)
      gitAt(overlayDir, '-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', 'FETCH_HEAD')
      assert.equal(gitAt(overlayDir, 'rev-parse', 'HEAD'), sha)
      assert.equal(realpathSync(gitAt(overlayDir, 'rev-parse', '--show-toplevel')), realpathSync(overlayDir))
      assert.equal(readFileSync(join(overlayDir, 'v.txt'), 'utf8'), expectedContent)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

