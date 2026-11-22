import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getSchema } from '@tiptap/core'
import { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { docToStored, isLongPaste, storedToDoc, type JSONNode } from './serialize'
import { chatEditorSchemaExtensions } from './schema'

const task = '0f8fad5b-d9cb-469f-a165-70867728950e'
const run = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const chat = '16fd2706-8baf-433b-82eb-8c7fada847da'
const pr = 'https://github.com/acme/web/pull/42'
const context = {
  people: [{ id: 'bot-1', name: 'Release Bot', kind: 'bot' as const }, { id: 'user-1', name: 'Ana', kind: 'person' as const }],
  skills: [{ slug: 'deploy-preview', name: 'Deploy preview' }],
  files: true,
}
const schema = getSchema(chatEditorSchemaExtensions())
/** Through ProseMirror's own schema, so a node the schema would reject or reshape fails here. */
const viaSchema = (doc: JSONNode) => ProseMirrorNode.fromJSON(schema, doc).toJSON() as JSONNode

const samples = [
  '',
  'plain text',
  `look at [[issue:${task}]] and [[run:${run}]] please`,
  `[[chat:${chat}]] then ${pr} merged`,
  'line one\n\nline three\n',
  '@Release Bot ship it, @Ana review',
  'run $deploy-preview on @src/app/page.tsx and @packages/daemon/',
  'mail ana@example.com stays text; @nobody stays text; $unknown stays text',
  '中文 [[issue:' + task + ']]，然后 @Ana。',
  '  spaced   out  ',
]

test('a stored message survives the editor document unchanged', () => {
  for (const stored of samples) assert.equal(docToStored(viaSchema(storedToDoc(stored, context))), stored, stored)
})

test('references, people, Bots, skills, files and folders become chips', () => {
  const doc = storedToDoc(`[[issue:${task}]] @Release Bot $deploy-preview @src/a.ts @lib/ ${pr}`, { ...context, label: reference => reference.type === 'task' ? 'MIK-12' : undefined })
  const chips = (doc.content?.[0].content ?? []).filter(node => node.type !== 'text')
  assert.deepEqual(chips.map(node => [node.type, node.attrs?.kind ?? node.attrs?.path, node.attrs?.label ?? node.attrs?.folder]), [
    ['mention', 'task', 'MIK-12'], ['mention', 'bot', 'Release Bot'], ['mention', 'skill', 'Deploy preview'],
    ['sourceFile', 'src/a.ts', false], ['sourceFile', 'lib', true], ['mention', 'pr', 'web#42'],
  ])
})

test('without a run to search, a path stays text', () => {
  const doc = storedToDoc('@src/a.ts', {})
  assert.deepEqual(doc.content?.[0].content, [{ type: 'text', text: '@src/a.ts' }])
})

test('a collapsed paste writes its whole text and an image writes nothing (its file marker travels with the files)', () => {
  const long = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n')
  assert.ok(isLongPaste(long))
  assert.ok(!isLongPaste('short'))
  assert.ok(isLongPaste('x'.repeat(1501)))
  const doc: JSONNode = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'see ' }, { type: 'pasted', attrs: { text: long } }, { type: 'image', attrs: { src: 'blob:1', alt: 'shot.png', fileKey: 'k1' } }, { type: 'text', text: ' ok' },
  ] }] }
  assert.equal(docToStored(viaSchema(doc)), `see ${long} ok`)
})

test('a hard break is a new line, as a new paragraph is', () => {
  const doc: JSONNode = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'c' }] }] }
  assert.equal(docToStored(viaSchema(doc)), 'a\nb\nc')
})

test('a paste sent as a text attachment writes nothing in the text, and its file opens as the chip again', () => {
  const attachments = [{ id: 'f1', name: 'pasted-text-2026-11-22T18-00-00-000Z.txt' }, { id: 'f2', name: 'shot.png' }]
  const doc = storedToDoc('see this', { attachments })
  assert.deepEqual(doc.content?.[0].content?.[0], { type: 'pasted', attrs: { text: '', fileKey: 'f1' } })
  assert.equal(doc.content?.[0].content?.length, 2, 'only the paste comes back as a chip; an image stays in the strip')
  assert.equal(docToStored(viaSchema(doc)), 'see this')
  assert.equal(docToStored(viaSchema({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'pasted', attrs: { text: 'long', fileKey: 'k' } }] }] })), '')
})
