import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evidenceErrors, mergeGroupPrNumber } from './pr-acceptance-evidence.mjs'

const TEMPLATE_SECTION = `## How it was checked

<!-- Run \`pnpm local:plan\`; local red→green first, then \`pnpm local:ready\` and \`pnpm local:mark-ready\`. The ignored local record is not automatic remote proof. -->

- Local source HEAD SHA: <!-- $SHA -->
- Affected tests selected (Nx) and actual commands/exits: <!-- … -->
- Local runtime outcome: <!-- … -->
- Product acceptance report or exact non-product exception: <!-- … -->
- CI run and final result (after Ready): <!-- … -->
`

test('untouched template fails', () => {
  const errors = evidenceErrors(TEMPLATE_SECTION)
  assert.ok(errors.length > 0)
})

test('missing section fails', () => {
  assert.deepEqual(evidenceErrors('## Summary\n\n- no section\n'), ['missing "## How it was checked" section'])
})

test('filled section passes', () => {
  const body = `## How it was checked\n\n- Local source HEAD SHA: ec3aaeb8\n- Affected tests selected (Nx) and actual commands/exits: corepack pnpm exec node --test tests/x.test.mjs → 12 pass\n- Product acceptance report or exact non-product exception: no product behavior change\n- CI run and final result (after Ready): pending\n`
  assert.deepEqual(evidenceErrors(body), [])
})

test('filled section that keeps the template guidance comment still passes', () => {
  const body = `## How it was checked\n\n<!-- Run \`pnpm local:plan\` first. -->\n\n- Local source HEAD SHA: ec3aaeb8\n- Actual commands/exits: node --test tests/x.test.mjs → 12 pass\n- Acceptance: no product behavior change\n\n## Other heading\n`
  assert.deepEqual(evidenceErrors(body), [])
})

test('SHA-only body fails for missing substantive fields', () => {
  const body = `## How it was checked\n\n- Local source HEAD SHA: ec3aaeb8\n- CI run and final result: pending\n`
  assert.ok(evidenceErrors(body).some(error => error.includes('two evidence fields')))
})

test('filled section without SHA fails', () => {
  const body = `## How it was checked\n\n- Local source HEAD SHA: N/A\n- Actual commands/exits: pnpm test → pass\n- Acceptance: no product behavior change\n`
  assert.ok(evidenceErrors(body).some(error => error.includes('HEAD SHA')))
})

test('a CI run URL does not satisfy the HEAD SHA requirement', () => {
  const body = `## How it was checked\n\n- Local source HEAD SHA: see https://example.com/actions/runs/12345678\n- Actual commands/exits: pnpm test → pass\n- Acceptance: no product behavior change\n`
  assert.ok(evidenceErrors(body).some(error => error.includes('HEAD SHA')))
})

test('merge_group head_ref yields the queued PR number', () => {
  assert.equal(mergeGroupPrNumber('refs/heads/gh-readonly-queue/main/pr-3150-20af61286165'), '3150')
  assert.equal(mergeGroupPrNumber('refs/heads/devin/x'), null)
})

test('the evidence gate runs on non-draft PRs and merge groups, joins the required aggregation, and reruns on body edits', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ui-policy.yml', import.meta.url), 'utf8')
  assert.match(workflow, /acceptance-evidence:\n    name: PR acceptance evidence\n/)
  assert.match(workflow, /types: \[[^\]]*edited\]/)
  assert.match(workflow, /if: needs\.changes\.result == 'success' && \(github\.event_name == 'merge_group' \|\| \(github\.event_name == 'pull_request' && github\.event\.pull_request\.draft != true\)\)/)
  assert.match(workflow, /needs: \[[^\]]*acceptance-evidence\]/)
  assert.match(workflow, /EXPECT_EVIDENCE: \$\{\{ github\.event_name == 'merge_group' \|\| \(github\.event_name == 'pull_request' && github\.event\.pull_request\.draft != true\) \}\}/)
})
