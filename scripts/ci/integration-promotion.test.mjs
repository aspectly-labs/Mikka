import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { inspectAcceptance } from './pr-acceptance-check.mjs'

const promotionWorkflow = readFileSync(
  new URL('../../.github/workflows/integration-to-main-promotion.yml', import.meta.url),
  'utf8',
)
const autopilotWorkflow = readFileSync(
  new URL('../../.github/workflows/merge-queue-autopilot.yml', import.meta.url),
  'utf8',
)

const SHA = '1111111111111111111111111111111111111111'

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

test('promotion workflow parses Ready (draft=false) and Draft (draft=true) PRs without jq -e aborting', () => {
  assert.match(promotionWorkflow, /jq -er '\.draft \| booleans \| tostring'/)
  for (const draft of [false, true]) {
    const out = execFileSync('jq', ['-er', '.draft | booleans | tostring'], {
      input: JSON.stringify({ draft }),
      encoding: 'utf8',
    }).trim()
    assert.equal(out, String(draft))
  }
})

test('promotion workflow keeps acceptance pending until CI passes and only passes with real evidence', () => {
  const pendingBody = `## Summary
Scheduled promotion of integration branch \`claude/affectionate-einstein-s235cb\` into \`main\`.

## Acceptance
Commit: ${SHA}
Runtime: both
Model: scripted (at the LiteLLM boundary)
Fixtures: awaiting CI run on this exact promotion head
Items: pending
Evidence: pending
Screenshots: not needed: backend integration promotion`

  const pendingResult = inspectAcceptance({ body: pendingBody, files: [{ filename: 'lib/example.ts' }], draft: false })
  assert.equal(pendingResult.status, 'fail', 'untested promotion head must not produce passing acceptance')
  assert.ok(pendingResult.errors.includes('acceptance.evidence-missing'))

  const verifiedBody = `## Summary
Scheduled promotion of integration branch \`claude/affectionate-einstein-s235cb\` into \`main\`.

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
})

test('promotion workflow evaluates readiness before dry_run/freeze guards and enqueues strictly via merge queue', () => {
  const mergeStateIdx = promotionWorkflow.indexOf('mergeStateStatus')
  const freezeGateIdx = promotionWorkflow.indexOf('if [ "${PROMOTE_ENABLED:-}" != "true" ]; then')
  const dryRunGateIdx = promotionWorkflow.indexOf('elif [ "${DRY_RUN:-false}" = "true" ]; then')
  assert.ok(mergeStateIdx > 0 && freezeGateIdx > mergeStateIdx && dryRunGateIdx > freezeGateIdx,
    'dry_run and freeze guards must run after evaluating PR mergeStateStatus and required checks')
  assert.match(promotionWorkflow, /enqueuePullRequest/)
  assert.doesNotMatch(promotionWorkflow, /\bgh pr merge\b/, 'promotion must never bypass main merge_group coverage via direct gh pr merge')
})
