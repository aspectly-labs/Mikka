import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROMPT_HISTORY_MAX, rememberPrompt, stepPrompt } from './prompt-history'

test('a prompt is kept once, newest last, trimmed and capped', () => {
  let history: string[] = []
  for (const prompt of ['a', ' b ', 'a', '', '   ']) history = rememberPrompt(history, prompt)
  assert.deepEqual(history, ['b', 'a'])
  for (let index = 0; index < PROMPT_HISTORY_MAX + 5; index++) history = rememberPrompt(history, `p${index}`)
  assert.equal(history.length, PROMPT_HISTORY_MAX)
  assert.equal(history.at(-1), `p${PROMPT_HISTORY_MAX + 4}`)
})

test('Up walks back to the oldest and stops; Down walks forward to the draft', () => {
  const history = ['one', 'two']
  assert.equal(stepPrompt(history, null, 'older'), 1)
  assert.equal(stepPrompt(history, 1, 'older'), 0)
  assert.equal(stepPrompt(history, 0, 'older'), undefined)
  assert.equal(stepPrompt(history, 0, 'newer'), 1)
  assert.equal(stepPrompt(history, 1, 'newer'), null)
  assert.equal(stepPrompt(history, null, 'newer'), undefined)
  assert.equal(stepPrompt([], null, 'older'), undefined)
})

test('a prompt’s document is kept once per prompt, newest last, and the oldest go first past the cap', async () => {
  const { rememberPromptDoc, PROMPT_DOCS_MAX_CHARS } = await import('./prompt-history')
  let docs = rememberPromptDoc([], { prompt: ' a ', doc: { type: 'doc' }, files: [] })
  docs = rememberPromptDoc(docs, { prompt: 'b', doc: { type: 'doc' }, files: [] })
  docs = rememberPromptDoc(docs, { prompt: 'a', doc: { type: 'doc', n: 2 }, files: [] })
  assert.deepEqual(docs.map(item => item.prompt), ['b', 'a'])
  const big = 'x'.repeat(20_000)
  for (let index = 0; index < 5; index++) docs = rememberPromptDoc(docs, { prompt: `p${index}`, doc: { big }, files: [] })
  assert.ok(JSON.stringify(docs).length <= PROMPT_DOCS_MAX_CHARS)
  assert.equal(docs.at(-1)?.prompt, 'p4')
})
