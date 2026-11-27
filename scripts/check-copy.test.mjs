import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { applyBaseline, labelShapeProblems } from './check-copy.mjs'

const rules = (key, value) => labelShapeProblems(key, value).map(problem => problem.rule)

test('C-11: a label, button, tab or title ends without a full stop', () => {
  assert.deepEqual(rules('Settings.saveButton', '保存。'), ['C-11-period'])
  assert.deepEqual(rules('ConversationDirectory.emptyTitle', 'No threads yet.'), ['C-11-period'])
  assert.deepEqual(rules('Settings.saveButton', '保存'), [])
  assert.deepEqual(rules('Shell.loadingTitle', 'Loading...'), [], 'an ellipsis is not a full stop')
  assert.deepEqual(rules('Shell.status.label', '{count, plural, one {# item.} other {# items.}}'), [], 'ICU branches are not literal text')
})

test('C-11: a label has no parenthetical note, except the optional-field mark', () => {
  assert.deepEqual(rules('Settings.modelLabel', '模型（用于新线程）'), ['C-11-paren'])
  assert.deepEqual(rules('Models.recommendedTitle', 'Claude Sonnet (recommended)'), ['C-11-paren'])
  assert.deepEqual(rules('Invite.skippedTitle', '{count} address(es) were not invited'), ['C-11-paren'])
  assert.deepEqual(rules('Issue.copyTitle', '{title}（副本）'), ['C-11-paren'], 'literal text around an argument still counts')
  assert.deepEqual(rules('Devices.baseBranchLabel', '基准分支（选填）'), [])
  assert.deepEqual(rules('Devices.baseBranchLabel', 'Base branch (optional)'), [])
  assert.deepEqual(rules('Devices.localPathLabel', '本地路径（可选）'), [])
  assert.deepEqual(rules('Thread.renameLabel', '重命名 {name}'), [])
})

test('C-11 applies to labels only; tooltips, placeholders and body text may be sentences', () => {
  assert.deepEqual(rules('Settings.modelTooltip', '用于新线程（可在设置里修改）。'), [])
  assert.deepEqual(rules('Settings.urlPlaceholder', '输入网址（例如 example.com）'), [])
  assert.deepEqual(rules('Settings.description', '模型用于新线程。'), [])
})

test('the C-11 ratchet fails only new hits and reports fixed baseline lines', () => {
  const hits = [{ id: 'a C-11-paren' }, { id: 'b C-11-period' }]
  const { fresh, stale } = applyBaseline(hits, ['a C-11-paren', 'c C-11-paren'])
  assert.deepEqual(fresh.map(hit => hit.id), ['b C-11-period'])
  assert.deepEqual(stale, ['c C-11-paren'])
})

test('the C-11 baseline is sorted, unique and only names C-11 rules', () => {
  const { c11 } = JSON.parse(readFileSync(new URL('./check-copy-baseline.json', import.meta.url), 'utf8'))
  assert.deepEqual(c11, [...new Set(c11)].sort())
  for (const id of c11) assert.match(id, /^messages\/(zh-CN|en)\.json \S+ C-11-(period|paren)$/)
})
