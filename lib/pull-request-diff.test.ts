import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { pullRequestDiffText, pullRequestUnifiedPatch } from './pull-request-diff'
import { parseUnifiedDiff } from './thread-changes'

const hunk = '@@ -1,2 +1,3 @@\n context\n-removed\n+added\n+and this\n'

test('a modified file keeps its path and line counts through the diff the page parses', () => {
  const changes = parseUnifiedDiff(pullRequestDiffText([
    { path: 'lib/app.ts', previousPath: null, status: 'modified', patch: hunk },
  ]))
  assert.deepEqual(changes.files.map(file => [file.path, file.previousPath, file.status]), [['lib/app.ts', null, 'modified']])
  assert.deepEqual([changes.additions, changes.deletions], [2, 1])
  assert.deepEqual(changes.files[0].blocks.filter(block => block.kind === 'line').map(block => block.kind === 'line' && block.line.kind),
    ['context', 'removed', 'added', 'added'])
})

test('added, deleted and renamed files carry the status the diff has to draw', () => {
  const changes = parseUnifiedDiff(pullRequestDiffText([
    { path: 'new/file.ts', previousPath: null, status: 'added', patch: '@@ -0,0 +1,1 @@\n+first\n' },
    { path: 'gone/old.ts', previousPath: null, status: 'deleted', patch: '@@ -1,1 +0,0 @@\n-last\n' },
    { path: 'renamed/to.ts', previousPath: 'renamed/from.ts', status: 'renamed', patch: null },
  ]))
  assert.deepEqual(changes.files.map(file => [file.path, file.previousPath, file.status]),
    [['new/file.ts', null, 'added'], ['gone/old.ts', null, 'deleted'], ['renamed/to.ts', 'renamed/from.ts', 'renamed']])
})

test('a file GitHub sent no patch for still lists, with no lines and no invented counts', () => {
  const changes = parseUnifiedDiff(pullRequestDiffText([
    { path: 'asset/logo.png', previousPath: null, status: 'modified', patch: null },
  ]))
  assert.equal(changes.files.length, 1)
  assert.equal(changes.files[0].binary, true)
  assert.deepEqual(changes.files[0].blocks, [])
  assert.deepEqual([changes.additions, changes.deletions], [0, 0])
})

test('no files is an empty diff, not a broken one', () => {
  assert.equal(pullRequestDiffText([]), '')
  assert.equal(pullRequestUnifiedPatch([]), '')
  assert.deepEqual(parseUnifiedDiff(pullRequestDiffText([])), { files: [], additions: 0, deletions: 0 })
})

test('pullRequestUnifiedPatch emits valid unified diff headers accepted by git apply --stat', () => {
  const patch = pullRequestUnifiedPatch([
    { path: 'lib/app.ts', previousPath: null, status: 'modified', patch: hunk },
    { path: 'new/file.ts', previousPath: null, status: 'added', patch: '@@ -0,0 +1,1 @@\n+first\n' },
    { path: 'gone/old.ts', previousPath: null, status: 'deleted', patch: '@@ -1,1 +0,0 @@\n-last\n' },
    { path: 'renamed/to.ts', previousPath: 'renamed/from.ts', status: 'renamed', patch: '@@ -1,1 +1,1 @@\n-old\n+new\n' },
    { path: 'asset/logo.png', previousPath: null, status: 'modified', patch: null },
  ])
  assert.match(patch, /--- a\/lib\/app\.ts\n\+\+\+ b\/lib\/app\.ts\n@@ -1,2 \+1,3 @@/)
  assert.match(patch, /--- \/dev\/null\n\+\+\+ b\/new\/file\.ts\n@@ -0,0 \+1,1 @@/)
  assert.match(patch, /--- a\/gone\/old\.ts\n\+\+\+ \/dev\/null\n@@ -1,1 \+0,0 @@/)
  assert.match(patch, /--- a\/renamed\/from\.ts\n\+\+\+ b\/renamed\/to\.ts\n@@ -1,1 \+1,1 @@/)
  assert.match(patch, /Binary files a\/asset\/logo\.png and b\/asset\/logo\.png differ/)

  const stat = execFileSync('git', ['apply', '--stat'], { input: patch, encoding: 'utf8' })
  assert.match(stat, /lib\/app\.ts\s+\|\s+3 \+\+-/)
  assert.match(stat, /new\/file\.ts\s+\|\s+1 \+/)
  assert.match(stat, /gone\/old\.ts\s+\|\s+1 -/)
})
