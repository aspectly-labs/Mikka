import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withoutPartialTable } from './stream-markdown'

test('a table whose delimiter row has not arrived is held back', () => {
  assert.equal(withoutPartialTable('Steps:\n\n| Step | State'), 'Steps:\n')
  assert.equal(withoutPartialTable('Steps:\n\n| Step | State |\n'), 'Steps:\n')
  assert.equal(withoutPartialTable('Steps:\n\n| Step | State |\n| -'), 'Steps:\n')
  assert.equal(withoutPartialTable('Steps:\n\n| Step | State |\n| --- |'), 'Steps:\n', 'fewer cells than the header')
})

test('a table draws once its delimiter row is whole, and its rows as they arrive', () => {
  for (const text of ['| A | B |\n| --- | -', '| A | B |\n|:--|--:|', '| A | B |\n| --- | --- |\n| 1 | 2', 'x\n\n| A | B |\n| --- | --- |\n| 1 |']) assert.equal(withoutPartialTable(text), text)
})

test('text without a table, or a pipe in code, is left alone', () => {
  for (const text of ['Plain words.', 'a | b', '```sh\nls | wc -l\n| x', '']) assert.equal(withoutPartialTable(text), text)
})
