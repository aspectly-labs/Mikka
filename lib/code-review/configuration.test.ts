import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codeReviewInstructions, factoryReviewPreferences } from './configuration'

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

test('a Factory review includes the whole saved ignore list', () => {
  const paths = Array.from({ length: 100 }, (_, index) => `${'directory'.repeat(25)}/${index}/**`)
  const instructions = codeReviewInstructions({ model: '', severity: 'medium', ignoredPaths: paths, output: 'comments' }, 'factory')
  assert.ok(instructions.includes(JSON.stringify(paths)))
  assert.doesNotMatch(instructions, /further saved globs/)
})

test('Factory preferences fit in the budget remaining after the original brief and handoff', () => {
  const ignoredPaths = Array.from({ length: 100 }, (_, index) => `${'directory'.repeat(25)}/${index}/**`)
  const config = { model: '', severity: 'medium', ignoredPaths, output: 'comments' } as const
  const instructions = codeReviewInstructions(config, 'factory', 1200)
  assert.ok(instructions.length <= 1200)
  assert.match(instructions, /further saved globs not listed here/)
  assert.match(instructions, /required acceptance criterion/)
  assert.equal(codeReviewInstructions(config, 'factory', 10), '')
})

test('supplementary characters use two code units in the Factory assignment budget', () => {
  const prompt = '😀'.repeat(49_500)
  const ignoredPaths = ['directory/'.repeat(24) + '**']
  const config = { model: '', severity: 'medium', ignoredPaths, output: 'comments' } as const
  const suffix = factoryReviewPreferences(config, prompt)
  assert.match(suffix, /Required task acceptance criteria/)
  assert.ok((prompt + suffix).length <= 100_000)
})
