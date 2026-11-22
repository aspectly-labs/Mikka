import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evidenceErrors } from './pr-acceptance-evidence.mjs'

const TEMPLATE_SECTION = `## How it was checked

<!-- Run \`pnpm local:plan\`; local red→green first, then \`pnpm local:ready\` and \`pnpm local:mark-ready\`. The ignored local record is not automatic remote proof. -->

- Local source HEAD SHA:
- Affected tests selected (Nx) and actual commands/exits:
- Local runtime / API / CLI / PG / UI outcome (expected vs observed):
- Product acceptance report or exact non-product exception:
- CI run and final result (after Ready):
`

test('untouched template fails', () => {
  const errors = evidenceErrors(`## What and why\n\nx\n\n${TEMPLATE_SECTION}`)
  assert.ok(errors.length > 0)
  assert.ok(errors.some(error => error.includes('empty template') || error.includes('no acceptance evidence')))
})

test('missing section fails', () => {
  assert.deepEqual(evidenceErrors('## What and why\n\nx'), ['missing "## How it was checked" section'])
})

test('filled evidence passes', () => {
  const body = `## How it was checked\n\n- Local source HEAD SHA: ec3aaeb8\n- Affected tests selected (Nx) and actual commands/exits: corepack pnpm exec node --test tests/x.test.mjs → 12 pass\n- Product acceptance report or exact non-product exception: no product behavior change\n- CI run and final result (after Ready): pending\n`
  assert.deepEqual(evidenceErrors(body), [])
})

test('the evidence gate runs on non-draft PRs and joins the required aggregation', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ui-policy.yml', import.meta.url), 'utf8')
  assert.match(workflow, /acceptance-evidence:\n    name: PR acceptance evidence\n/)
  assert.match(workflow, /if: github\.event_name == 'pull_request' && github\.event\.pull_request\.draft != true && needs\.changes\.result == 'success'/)
  assert.match(workflow, /needs: \[[^\]]*acceptance-evidence\]/)
  assert.match(workflow, /EXPECT_EVIDENCE: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.draft != true \}\}/)
})

test('filled section without SHA fails', () => {
  const body = `## How it was checked\n\n- Local source HEAD SHA: N/A\n- Actual commands/exits: pnpm test → pass\n`
  assert.ok(evidenceErrors(body).some(error => error.includes('HEAD SHA')))
})
