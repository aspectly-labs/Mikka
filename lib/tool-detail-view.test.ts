import assert from 'node:assert/strict'
import { test } from 'node:test'
import { languageOf, outputText, toolDetailView } from './tool-detail-view'

// Alex, 2026-11-22: an opened tool call reads as what it did, not as raw JSON.

test('a file read is the file, in its language, without Claude Code\'s line numbers', () => {
  assert.deepEqual(toolDetailView({ kind: 'read', target: 'lib/auth/redirect.ts', input: '{"path":"lib/auth/redirect.ts"}', output: '{"type":"text","value":"export function readRedirect() {}"}' }),
    { type: 'file', path: 'lib/auth/redirect.ts', language: 'typescript', code: 'export function readRedirect() {}' })
  const numbered = toolDetailView({ kind: 'read', target: 'a.py', output: '     1→import os\n     2→\n     3→print(os.name)\n' })
  assert.deepEqual(numbered, { type: 'file', path: 'a.py', language: 'python', code: 'import os\n\nprint(os.name)' })
})

test('a search is its matches, one per line', () => {
  assert.deepEqual(toolDetailView({ kind: 'search', target: 'readRedirect', output: 'lib/auth/redirect.ts:3:export function readRedirect\napp/login/page.tsx:12:readRedirect(c)\n' }),
    { type: 'matches', query: 'readRedirect', lines: ['lib/auth/redirect.ts:3:export function readRedirect', 'app/login/page.tsx:12:readRedirect(c)'] })
})

test('an edit is a diff of what it replaced; a write is the file it wrote', () => {
  assert.deepEqual(toolDetailView({ kind: 'edit', target: 'lib/a.ts', input: JSON.stringify({ file_path: 'lib/a.ts', old_string: 'return x', new_string: 'return y\n// done' }) }),
    { type: 'diff', file: 'lib/a.ts', language: 'typescript', lines: [{ type: 'removed', content: 'return x' }, { type: 'added', content: 'return y' }, { type: 'added', content: '// done' }] })
  const multi = toolDetailView({ kind: 'edit', target: 'b.go', input: JSON.stringify({ file_path: 'b.go', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: '' }] }) })
  assert.equal(multi?.type, 'diff')
  assert.deepEqual(toolDetailView({ kind: 'edit', target: 'c.md', input: JSON.stringify({ file_path: 'c.md', content: '# Title' }) }),
    { type: 'file', path: 'c.md', language: 'markdown', code: '# Title' })
})

test('any other tool, as AI Elements\' Tool: parameters only when the row does not show them, then the result or error', () => {
  // The row shows ALEX-45: parameters that hold only that are not repeated.
  assert.deepEqual(toolDetailView({ kind: 'other', target: 'ALEX-45', input: JSON.stringify({ identifier: 'ALEX-45' }), output: '找到 1 个任务' }),
    { type: 'generic', output: { text: '找到 1 个任务', json: false } })
  // More than the target: the whole input once, as JSON.
  assert.deepEqual(toolDetailView({ kind: 'other', target: 'ALEX-45', input: JSON.stringify({ identifier: 'ALEX-45', limit: 5 }) }),
    { type: 'generic', params: { text: '{\n  "identifier": "ALEX-45",\n  "limit": 5\n}', json: true } })
  const json = toolDetailView({ kind: 'other', input: '{}', output: '{"runId":"r1","status":"queued"}' })
  assert.deepEqual(json, { type: 'generic', output: { text: '{\n  "runId": "r1",\n  "status": "queued"\n}', json: true } })
  // An input preview cut at 200 characters is not JSON: it is shown as it came, once.
  assert.deepEqual(toolDetailView({ kind: 'other', input: '{"prompt":"修复登录重定向并补一条回归' }),
    { type: 'generic', params: { text: '{"prompt":"修复登录重定向并补一条回归', json: false } })
  // A failure is its error, not a read file.
  assert.deepEqual(toolDetailView({ kind: 'read', target: 'a.ts', output: 'ENOENT: no such file', failed: true }),
    { type: 'generic', output: { text: 'ENOENT: no such file', json: false }, error: true })
  assert.equal(toolDetailView({ kind: 'other' }), null, 'nothing recorded, nothing to open')
})

test('languages and text envelopes', () => {
  assert.equal(languageOf('Dockerfile'), 'docker')
  assert.equal(languageOf('x/y.unknown'), undefined)
  assert.equal(outputText('{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}'), 'a\nb')
  assert.equal(outputText('"quoted"'), 'quoted')
})
