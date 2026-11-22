import type { WorkspaceEntry, WorkspaceFileResult, WorkspaceReadResult } from '@mikka/protocol/coding-workspace'
import { withBasePath } from '@/lib/base-path'

/** The checkout the Files tab reads: what readThreadWorkspace names, plus the workspace the read is scoped to. */
export type FilesScope = { runId: string; repoId: string; workspaceId: string }

/** A failed read keeps the endpoint's code (machine asleep, offline, gone), so the tab can say why. */
export class WorkspaceFilesError extends Error {
  constructor(readonly code: string) { super(code) }
}

type Read =
  | { kind: 'tree'; path: string; cursor?: string }
  | { kind: 'file'; path: string }
  | { kind: 'search'; query: string }

/**
 * One read of the thread's checkout through the workspace file API (`/api/runs/:runId/workspace/files`, #1721), the
 * same endpoint and checks the review page's Files use: the answer must be for this run, repository and workspace.
 */
export async function readWorkspaceFiles(scope: FilesScope, input: Read, signal?: AbortSignal): Promise<WorkspaceReadResult & { ok: true }> {
  const search = new URLSearchParams({ workspaceId: scope.workspaceId, repoId: scope.repoId, kind: input.kind })
  if (input.kind === 'search') search.set('query', input.query)
  else search.set('path', input.path)
  if (input.kind === 'tree' && input.cursor) search.set('cursor', input.cursor)
  const response = await fetch(withBasePath(`/api/runs/${scope.runId}/workspace/files?${search}`), { credentials: 'same-origin', cache: 'no-store', signal })
  const body: unknown = await response.json().catch(() => null)
  const result = body && typeof body === 'object' && !Array.isArray(body) ? body as WorkspaceReadResult : null
  if (!result) throw new WorkspaceFilesError(`http_${response.status}`)
  if (result.ok !== true) throw new WorkspaceFilesError(typeof (result as { code?: unknown }).code === 'string' ? (result as { code: string }).code : `http_${response.status}`)
  const identity = 'identity' in result ? result.identity : undefined
  if (result.kind !== input.kind || !identity || identity.runId !== scope.runId || identity.repoId !== scope.repoId || identity.workspaceId !== scope.workspaceId)
    throw new WorkspaceFilesError('workspace_scope')
  return result
}

export type TreePage = { entries: WorkspaceEntry[]; nextCursor: string | null }

export async function readTree(scope: FilesScope, path: string, cursor?: string, signal?: AbortSignal): Promise<TreePage> {
  const result = await readWorkspaceFiles(scope, { kind: 'tree', path, cursor }, signal)
  if (result.kind !== 'tree' || !Array.isArray(result.entries)) throw new WorkspaceFilesError('workspace_scope')
  return { entries: result.entries.filter(entry => entry && typeof entry.path === 'string' && (entry.kind === 'directory' || entry.kind === 'file')), nextCursor: result.nextCursor ?? null }
}

export async function readFile(scope: FilesScope, path: string, signal?: AbortSignal): Promise<WorkspaceFileResult> {
  const result = await readWorkspaceFiles(scope, { kind: 'file', path }, signal)
  if (result.kind !== 'file') throw new WorkspaceFilesError('workspace_scope')
  return result
}

export async function searchFiles(scope: FilesScope, query: string, signal?: AbortSignal): Promise<WorkspaceEntry[]> {
  const result = await readWorkspaceFiles(scope, { kind: 'search', query }, signal)
  if (result.kind !== 'search' || !Array.isArray(result.entries)) throw new WorkspaceFilesError('workspace_scope')
  return result.entries
}

/** M / A / D / R for a changed path, as the tree marks it (Figma 1318:15). */
export const changeMark = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R' } as const

/** The download link of an upload: the chat attachment endpoint signs it (`?download`), never a raw storage URL. */
export const uploadDownloadUrl = (id: string) => withBasePath(`/api/chat/attachments/${id}?download`)
