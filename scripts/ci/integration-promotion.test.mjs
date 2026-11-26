import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
} from './integration-promotion-probe.mjs'

const promotionWorkflow = readFileSync(
  new URL('../../.github/workflows/integration-to-main-promotion.yml', import.meta.url),
  'utf8',
)
const autopilotWorkflow = readFileSync(
  new URL('../../.github/workflows/merge-queue-autopilot.yml', import.meta.url),
  'utf8',
)

const SHA = '1111111111111111111111111111111111111111'
const SHA2 = '2222222222222222222222222222222222222222'
const SHA3 = '3333333333333333333333333333333333333333'

test('merge-queue-autopilot excludes integration promotion PRs while keeping normal Ready PRs', () => {
  assert.match(autopilotWorkflow, /INTEGRATION_BRANCH:\s*\$\{\{\s*vars\.MIKKA_INTEGRATION_BRANCH\s*\}\}/)
  assert.match(autopilotWorkflow, /select\(\$pr\.head\.ref != \$integration_branch\)/)
  const filterMatch = autopilotWorkflow.match(/jq -c[\s\S]*?'([\s\S]*?)' <<< "\$prs"/)
  assert.ok(filterMatch, 'autopilot jq candidate filter must exist')
  const filter = filterMatch[1]
  const runJq = (prs, branch, integrationBranch = 'claude/affectionate-einstein-s235cb') =>
    execFileSync('jq', [
      '-c',
      '--arg', 'head', SHA,
      '--arg', 'branch', branch,
      '--arg', 'repo', 'aspectly-labs/Mikka',
      '--arg', 'integration_branch', integrationBranch,
      filter,
    ], { input: JSON.stringify(prs), encoding: 'utf8' }).trim()

  const promotionPr = [[{
    number: 4001,
    node_id: 'PR_promo',
    state: 'open',
    draft: false,
    base: { ref: 'main' },
    head: { sha: SHA, ref: 'claude/affectionate-einstein-s235cb', repo: { full_name: 'aspectly-labs/Mikka' } },
  }]]
  assert.equal(runJq(promotionPr, 'claude/affectionate-einstein-s235cb'), '', 'autopilot must never enqueue the integration promotion PR')

  const normalPr = [[{
    number: 4002,
    node_id: 'PR_normal',
    state: 'open',
    draft: false,
    base: { ref: 'main' },
    head: { sha: SHA, ref: 'feat/regular-fix', repo: { full_name: 'aspectly-labs/Mikka' } },
  }]]
  assert.deepEqual(JSON.parse(runJq(normalPr, 'feat/regular-fix')), { id: 'PR_normal', number: 4002 })
})

test('promotion workflow parses cleanly as YAML with four isolated jobs and strict security boundaries', () => {
  const parsed = yaml.load(promotionWorkflow)
  assert.deepEqual(Object.keys(parsed.jobs), ['plan', 'auto-sync', 'verify-overlay-pairing', 'promote'])
  assert.match(parsed.env.PROBE_DOCKER_IMAGE, /^node:24-bookworm-slim@sha256:[0-9a-f]{64}$/)

  // Plan resolves exact branch tip from /branches/<ref> (immune to 250-commit /compare limit),
  // verifies sync PR includes BOTH main and current integration base, and does NOT use legacy
  // MIKKA_INTEGRATION_PROMOTE_TO_MAIN to disable compatibility checks.
  const planEval = parsed.jobs.plan.steps.find(step => step.id === 'eval')
  assert.ok(planEval)
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

  // Promote job never checks out integration code, re-verifies live main/branch tips after the
  // overlay probe before creating or enqueueing, and never calls gh pr merge on main.
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

  // Auto-sync refreshes stale integration base, re-verifies live base SHA before merge,
  // merges ONLY verified non-main integration PRs with exact head match, and never force-pushes.
  const syncScript = parsed.jobs['auto-sync'].steps.map(step => step.run ?? '').join('\n')
  assert.match(syncScript, /test "\$BRANCH" != "main"/)
  assert.match(syncScript, /test "\$base_ref" != "main"/)
  assert.match(syncScript, /live_base_sha.*EXPECTED_BASE_SHA/)
  assert.match(syncScript, /--merge --delete-branch --match-head-commit/)
  assert.doesNotMatch(syncScript, /--force|-f\s+origin/, 'auto-sync must never force-push')

  // Overlay pairing job stages trusted probe from main, pulls digest-pinned Docker sandbox,
  // scrubs credentials before pnpm/node, installs overlay with --prod --ignore-scripts, passes
  // --docker-image for --network none isolation, and cleans up .hosted-ui in always().
  const probeSteps = parsed.jobs['verify-overlay-pairing'].steps
  const pullIdx = probeSteps.findIndex(step => /Pull digest-pinned sandbox image/i.test(step.name ?? ''))
  const scrubIdx = probeSteps.findIndex(step => /Scrub App credentials/i.test(step.name ?? ''))
  const installIdx = probeSteps.findIndex(step => /Install public workspace/i.test(step.name ?? ''))
  const probeIdx = probeSteps.findIndex(step => step.id === 'probe')
  const cleanupStep = probeSteps.find(step => step.if === 'always()')
  assert.ok(pullIdx > 0 && scrubIdx > pullIdx && installIdx > scrubIdx && probeIdx > installIdx)
  assert.ok(cleanupStep && /rm -rf \.hosted-ui/.test(cleanupStep.run ?? ''))
  assert.match(probeSteps[installIdx].run, /--ignore-scripts/)
  assert.match(probeSteps[probeIdx].run, /--prod --ignore-scripts/)
  assert.match(probeSteps[probeIdx].run, /--docker-image "\$PROBE_DOCKER_IMAGE"/)
  assert.match(probeSteps[probeIdx].run, /trusted-probe\/integration-promotion-probe\.mjs/)
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
  // If a feature PR merged into integration after sync PR passed CI (syncPrIncludesBase=false),
  // must refresh sync PR and require fresh CI — NEVER merge stale checks!
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

test('evaluatePromotionGate requires approved pinned_overlay by default and treats coordinated_ui_pr as readiness evidence only', () => {
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

  // Coordinated UI PR alone must NOT auto-enqueue an unshippable pair onto main by default.
  const coordinatedOnly = evaluatePromotionGate({
    ...common,
    overlayMode: 'coordinated_ui_pr',
    overlaySummary: 'pinned_overlay@11111111: compatible=false; coordinated_ui_pr@22222222: compatible=true',
  })
  assert.equal(coordinatedOnly.effectiveAction, 'noop')
  assert.match(coordinatedOnly.effectiveReason, /readiness evidence only/)

  // Explicit operator break-glass allows coordinated_ui_pr or probe skip.
  assert.equal(
    evaluatePromotionGate({ ...common, overlayMode: 'coordinated_ui_pr', allowCoordinatedUnpinned: true }).effectiveAction,
    'enqueue_pr',
  )
  assert.equal(
    evaluatePromotionGate({ ...common, overlayProbeRan: false, overlayCompatible: false, skipOverlayProbe: true }).effectiveAction,
    'enqueue_pr',
  )
  // Recording verified evidence on an already-open promotion PR stays allowed without re-running overlay probe.
  assert.equal(
    evaluatePromotionGate({ ...common, plannedAction: 'record_evidence', overlayProbeRan: false, overlayCompatible: false }).effectiveAction,
    'record_evidence',
  )
})

test('buildMinimalProbeEnv and buildIsolatedDockerArgs strip GitHub Actions files, tokens, and network access', () => {
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
  assert.equal(clean.HOME, '/tmp')
  assert.equal(clean.TMPDIR, '/tmp')

  const dockerArgs = buildIsolatedDockerArgs({
    dockerImage: 'node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9',
    absRepo: '/work/repo',
    envVars: { HOME: '/tmp', MIKKA_UI_OVERLAY_SHA: SHA3 },
    cmd: ['node', 'apps/frontend/scripts/build.mjs', 'web'],
  })
  assert.ok(dockerArgs.includes('--network') && dockerArgs[dockerArgs.indexOf('--network') + 1] === 'none')
  assert.ok(dockerArgs.includes('--cap-drop') && dockerArgs[dockerArgs.indexOf('--cap-drop') + 1] === 'ALL')
  assert.ok(dockerArgs.includes('no-new-privileges'))
  assert.ok(!dockerArgs.some(arg => /GITHUB_STEP_SUMMARY|GITHUB_OUTPUT|RUNNER_TEMP/.test(arg)))
})
