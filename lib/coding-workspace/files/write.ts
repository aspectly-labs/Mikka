import 'server-only'
import type { Pool } from 'pg'
import {
  CodingWorkspaceError, workspaceFileSaveRequest, workspaceFileRenameRequest, workspaceFileDeleteRequest,
  type WorkspaceFileWriteResult, type WorkspaceReadRequest, type WorkspaceReadResult,
} from '@mikka/protocol/coding-workspace'
import { WORKSPACE_GIT_OPERATION_TTL_MS, WORKSPACE_GIT_UNDO_TTL_MS, WorkspaceGitError } from '@mikka/protocol/coding-workspace-git'
import { runChanged } from '../../live/panels'
import { requestWorkspaceRead } from '../requests'
import { resolveReviewScope, withReviewTransaction, type ReviewActor } from '../diff/authority'
import { gitDigest } from '../git/evidence'
import { claimOperation, finishOperation, insertPreview, releaseOperation, type GitOperationRow } from '../git/ops'

export type FileWriteDependencies = { database: Pool; membership: Pool }
const retryable = (error: unknown) => error instanceof CodingWorkspaceError
  && ['workspace_machine_unavailable', 'workspace_checkout_unavailable', 'workspace_request_expired'].includes(error.code)

export type FileWriteInput =
  | { kind: 'save'; operationId: string; path: string; expected: unknown; encoding: 'utf8' | 'base64'; content: string; executable?: boolean }
  | { kind: 'rename'; operationId: string; path: string; newPath: string; expected: unknown }
  | { kind: 'delete'; operationId: string; path: string; expected: unknown }

function requestFor(input: FileWriteInput): WorkspaceReadRequest {
  if (input.kind === 'save') return workspaceFileSaveRequest.parse({ kind: 'file_save', operationId: input.operationId,
    path: input.path, expected: input.expected, encoding: input.encoding, content: input.content, executable: input.executable ?? false })
  if (input.kind === 'rename') return workspaceFileRenameRequest.parse({ kind: 'file_rename', operationId: input.operationId,
    path: input.path, newPath: input.newPath, expected: input.expected })
  return workspaceFileDeleteRequest.parse({ kind: 'file_delete', operationId: input.operationId, path: input.path, expected: input.expected })
}

function fingerprint(runId: string, repoId: string, input: FileWriteInput) {
  return gitDigest(JSON.stringify([runId, repoId, input.kind, input.operationId, input.path,
    input.kind === 'rename' ? input.newPath : null, input.expected, input.kind === 'save' ? [input.encoding, input.content, input.executable ?? false] : null]))
}

async function finished(row: GitOperationRow) {
  const receipt = row.receipt
  if (!receipt || typeof receipt !== 'object') throw new WorkspaceGitError('workspace_git_operation_conflict')
  return { ...(receipt as WorkspaceFileWriteResult), undoAvailable: row.undoAvailable }
}

/** One-shot CAS write: the operation row is the audit record and the idempotent
 * replay anchor. A retry with the same id replays the stored payload — never a
 * second intent with a different body. */
export async function writeRunFile(dependencies: FileWriteDependencies, actor: ReviewActor, runId: string, repoId: string,
  input: FileWriteInput, signal?: AbortSignal): Promise<WorkspaceFileWriteResult & { undoAvailable?: boolean }> {
  await resolveReviewScope(dependencies.database, dependencies.membership, actor, runId, repoId)
  const request = requestFor(input)
  const operationKind = input.kind === 'save' ? 'save' : input.kind === 'rename' ? 'rename' : 'delete'
  await withReviewTransaction(dependencies.database, dependencies.membership, actor, runId, repoId, async client => {
    await insertPreview(client, { operationId: input.operationId, runId, repoId, ownerId: actor.userId, workspaceId: actor.workspaceId,
      kind: operationKind, requestFingerprint: fingerprint(runId, repoId, input),
      previewVersion: fingerprint(runId, repoId, input), checkpointId: null,
      revision: { source: 'working' }, files: [{ path: input.path, ...(input.kind === 'rename' ? { newPath: input.newPath } : {}) }],
      expected: input.expected, payload: request, expiresAt: new Date(Date.now() + WORKSPACE_GIT_OPERATION_TTL_MS) })
  }, { historical: true, signal })
  const claimed = await withReviewTransaction(dependencies.database, dependencies.membership, actor, runId, repoId,
    async client => claimOperation(client, actor.userId, input.operationId), { historical: true, signal })
  if (claimed.kind === 'finished') {
    if (claimed.row.kind !== operationKind || claimed.row.state !== 'applied')
      throw new WorkspaceGitError('workspace_git_operation_conflict')
    return finished(claimed.row)
  }
  const payload = claimed.row.payload
  if (claimed.row.kind !== operationKind || !payload || typeof payload !== 'object') {
    await releaseOperation(dependencies.database, actor.userId, input.operationId, false)
    throw new WorkspaceGitError('workspace_git_operation_conflict')
  }
  const stored = workspaceFileSaveRequest.or(workspaceFileRenameRequest).or(workspaceFileDeleteRequest).safeParse(payload)
  if (!stored.success || stored.data.operationId !== input.operationId) {
    await releaseOperation(dependencies.database, actor.userId, input.operationId, false)
    throw new WorkspaceGitError('workspace_git_operation_conflict')
  }
  let applied: WorkspaceReadResult
  try {
    const result = await requestWorkspaceRead(dependencies.database, dependencies.membership, actor, runId, repoId,
      stored.data, signal, { ttlMs: 60_000 })
    if (!result.ok) throw new CodingWorkspaceError(result.code)
    applied = result
  } catch (error) {
    await releaseOperation(dependencies.database, actor.userId, input.operationId, retryable(error))
    throw error
  }
  return withReviewTransaction(dependencies.database, dependencies.membership, actor, runId, repoId, async client => {
    const saved = await finishOperation(client, actor.userId, input.operationId, applied,
      new Date(Date.now() + WORKSPACE_GIT_UNDO_TTL_MS))
    await runChanged(client, runId)
    return { ...(applied as WorkspaceFileWriteResult), undoAvailable: saved.undoAvailable }
  }, { historical: true, signal })
}
