import assert from 'node:assert/strict'
import test from 'node:test'
import { composerDisplay, editComposerDisplay, insertComposerReference, messageReferences, referenceMarkerOf, slashCommandAt, tokenAtCaret } from './composer-references'

const task = '11111111-1111-4111-8111-111111111111'
const run = '22222222-2222-4222-8222-222222222222'
const chat = '33333333-3333-4333-8333-333333333333'
const pr = 'https://github.com/acme/mikka/pull/2837'
const names: Record<string, string> = { [task]: 'MIKK-56', [run]: 'Rebuild the loading state', [chat]: 'Design review', [pr]: 'mikka#2837' }
const label = (reference: { id: string }) => names[reference.id] ?? reference.id

test('a message lists its typed references with their places in the stored text', () => {
  const text = `Compare ${pr} with [[issue:${task}]] and continue in [[run:${run}]] or [[chat:${chat}]].`
  const references = messageReferences(text)
  assert.deepEqual(references.map(item => [item.type, item.id]), [['pr', pr], ['task', task], ['thread', run], ['chat', chat]])
  for (const reference of references) assert.equal(text.slice(reference.offset, reference.offset + reference.length), referenceMarkerOf(reference.type, reference.id))
  // A bare id, a labelled link and another site's URL stay words.
  assert.deepEqual(messageReferences(`${task} [the PR](${pr}) https://github.com.example/a/b/pull/1`), [])
})

test('the composer shows names, and an edit that touches a name removes the whole reference', () => {
  const stored = `fix [[issue:${task}]] now`
  const display = composerDisplay(stored, label)
  assert.equal(display.text, 'fix MIKK-56 now')
  assert.deepEqual(display.tokens.map(token => [token.from, token.to]), [[4, 11]])
  // Typing after the name keeps it.
  assert.equal(editComposerDisplay(stored, display, 'fix MIKK-56 now!', 16), `fix [[issue:${task}]] now!`)
  // Deleting its last letter removes the reference, never half a marker.
  assert.equal(editComposerDisplay(stored, display, 'fix MIKK-5 now', 10), 'fix  now')
  // Selecting the name and typing over it replaces it.
  assert.equal(editComposerDisplay(stored, display, 'fix it now', 6), 'fix it now')
  // Typing before it keeps it.
  assert.equal(editComposerDisplay(stored, display, 'please fix MIKK-56 now', 7), `please fix [[issue:${task}]] now`)
  assert.equal(editComposerDisplay(stored, display, display.text), stored)
})

test('Backspace at the end of a name selects it first, and a picked result replaces the typed mention', () => {
  const stored = `see [[run:${run}]]`
  const display = composerDisplay(stored, label)
  assert.equal(tokenAtCaret(display, display.text.length, 'Backspace')?.label, 'Rebuild the loading state')
  assert.equal(tokenAtCaret(display, 4, 'Delete')?.reference.id, run)
  assert.equal(tokenAtCaret(display, 5, 'Backspace'), null)
  const typed = `${stored} and @task:mik`
  const shown = composerDisplay(typed, label)
  const from = shown.text.indexOf('@task:')
  assert.equal(insertComposerReference(typed, shown, from, shown.text.length, referenceMarkerOf('task', task)), `see [[run:${run}]] and [[issue:${task}]] `)
})

test('a slash command is a whole draft of one slash word', () => {
  assert.deepEqual(slashCommandAt('/ne', 3), { query: 'ne' })
  assert.deepEqual(slashCommandAt('/', 1), { query: '' })
  assert.equal(slashCommandAt('please /new', 11), null)
  assert.equal(slashCommandAt('/new task', 4), null)
})
