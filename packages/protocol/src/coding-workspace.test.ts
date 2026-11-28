import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  matchesWorkspaceResponse, workspaceRequestPathsAllowed, workspaceFileWriteRequest,
  type RunWorktreeIdentity, type WorkspaceFileWriteResult,
} from './coding-workspace'

const sha = 'a'.repeat(40)
const digest = 'b'.repeat(64)
const identity: RunWorktreeIdentity = {
  version: 1, runId: crypto.randomUUID(), repoId: crypto.randomUUID(), deviceId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(), ownerId: 'owner-1', repositoryKey: 'aspectly-labs/mikka', bindingId: digest,
}
const revision = { source: 'working' as const, headSha: sha, baseSha: null, version: digest }
const fence = { exists: true, contentSha256: digest, mode: '100644' as const, workingVersion: 'v1' }

function writeResult(kind: 'file_saved' | 'file_renamed' | 'file_deleted', path: string, after: WorkspaceFileWriteResult['after'], extra: Partial<WorkspaceFileWriteResult> = {}): WorkspaceFileWriteResult {
  return { ok: true, identity, revision, observedAt: new Date().toISOString(), availability: 'online',
    kind, operationId: crypto.randomUUID(), appliedAt: new Date().toISOString(), headSha: sha,
    path, newPath: null, after, idempotent: false, ...extra }
}

describe('workspace file write requests', () => {
  it('parses save, rename and delete envelopes inside the read union', () => {
    const operationId = crypto.randomUUID()
    const save = workspaceFileWriteRequest.parse({ kind: 'file_save', operationId, path: 'src/a.ts', expected: fence, encoding: 'utf8', content: 'x', executable: false })
    expect(save.kind).toBe('file_save')
    expect(workspaceFileWriteRequest.parse({ kind: 'file_rename', operationId, path: 'a', newPath: 'b', expected: fence }).kind).toBe('file_rename')
    expect(workspaceFileWriteRequest.parse({ kind: 'file_delete', operationId, path: 'a', expected: fence }).kind).toBe('file_delete')
    expect(workspaceFileWriteRequest.safeParse({ kind: 'file_save', operationId, path: 'a', expected: fence, encoding: 'base64', content: 'x'.repeat(2 * 1024 * 1024), executable: false }).success).toBe(false)
  })

  it('gates every touched path through the visible-workspace root', () => {
    const operationId = crypto.randomUUID()
    expect(workspaceRequestPathsAllowed({ kind: 'file_save', operationId, path: 'src/a.ts', expected: fence, encoding: 'utf8', content: 'x', executable: false })).toBe(true)
    expect(workspaceRequestPathsAllowed({ kind: 'file_save', operationId, path: '../a', expected: fence, encoding: 'utf8', content: 'x', executable: false })).toBe(false)
    expect(workspaceRequestPathsAllowed({ kind: 'file_rename', operationId, path: 'a', newPath: '.ssh/authorized_keys', expected: fence })).toBe(false)
    expect(workspaceRequestPathsAllowed({ kind: 'file_delete', operationId, path: 'node_modules/pkg/bin.js', expected: fence })).toBe(false)
  })
})

describe('matchesWorkspaceResponse file write receipts', () => {
  const operationId = crypto.randomUUID()
  const saveRequest = { kind: 'file_save' as const, operationId, path: 'src/a.ts', expected: fence, encoding: 'utf8' as const, content: 'console.log(1)\n', executable: false }
  const contentSha = createHash('sha256').update(new TextEncoder().encode('console.log(1)\n')).digest('hex')
  const savedAfter = { exists: true, mode: '100644' as const, size: 15, contentSha256: contentSha, workingVersion: 'v2' }

  it('accepts a saved receipt bound to the operation, path and content hash', () => {
    const result = writeResult('file_saved', 'src/a.ts', savedAfter, { operationId })
    expect(matchesWorkspaceResponse(saveRequest, identity, result)).toBe(true)
  })

  it('rejects a receipt whose after-state hash does not match the authorized content', () => {
    const result = writeResult('file_saved', 'src/a.ts', { ...savedAfter, contentSha256: digest }, { operationId })
    expect(matchesWorkspaceResponse(saveRequest, identity, result)).toBe(false)
    const wrongPath = writeResult('file_saved', 'src/b.ts', savedAfter, { operationId })
    expect(matchesWorkspaceResponse(saveRequest, identity, wrongPath)).toBe(false)
    const wrongOperation = writeResult('file_saved', 'src/a.ts', savedAfter)
    expect(matchesWorkspaceResponse(saveRequest, identity, wrongOperation)).toBe(false)
  })

  it('binds renames to both paths and deletes to a non-existent after-state', () => {
    const rename = { kind: 'file_rename' as const, operationId, path: 'src/a.ts', newPath: 'src/b.ts', expected: fence }
    const renamed = writeResult('file_renamed', 'src/a.ts', savedAfter, { operationId, newPath: 'src/b.ts' })
    expect(matchesWorkspaceResponse(rename, identity, renamed)).toBe(true)
    expect(matchesWorkspaceResponse(rename, identity, { ...renamed, newPath: 'src/c.ts' })).toBe(false)
    const remove = { kind: 'file_delete' as const, operationId, path: 'src/a.ts', expected: fence }
    const deleted = writeResult('file_deleted', 'src/a.ts', { exists: false, mode: null, size: null, contentSha256: null, workingVersion: 'v2' }, { operationId })
    expect(matchesWorkspaceResponse(remove, identity, deleted)).toBe(true)
    expect(matchesWorkspaceResponse(remove, identity, { ...deleted, after: { ...deleted.after, exists: true } })).toBe(false)
  })

  it('rejects a receipt from a different worktree identity', () => {
    const result = writeResult('file_saved', 'src/a.ts', savedAfter, { operationId, identity: { ...identity, repoId: crypto.randomUUID() } })
    expect(matchesWorkspaceResponse(saveRequest, identity, result)).toBe(false)
  })
})
