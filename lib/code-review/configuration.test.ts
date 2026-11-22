import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codeReviewInstructions } from './configuration'

test('a saved ignore list keeps the review request inside the 10,000-character task limit', () => {
  const paths = Array.from({ length: 100 }, (_, index) => `${'directory'.repeat(25)}/${index}/**`)
  const instructions = codeReviewInstructions({ model: '', severity: 'medium', ignoredPaths: paths, output: 'comments' })
  assert.ok(instructions.length < 6000, `instructions were ${instructions.length} characters`)
  assert.match(instructions, /further saved globs not listed here/)
  assert.match(instructions, /directory.*\/0\/\*\*/)
})

test('an ignore list that fits is listed in full', () => {
  const instructions = codeReviewInstructions({ model: '', severity: 'low', ignoredPaths: ['vendor/**', 'docs/**'], output: 'summary' })
  assert.match(instructions, /\["vendor\/\*\*","docs\/\*\*"\]/)
  assert.doesNotMatch(instructions, /further saved globs/)
})
