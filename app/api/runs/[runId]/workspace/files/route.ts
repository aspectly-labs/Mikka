import { z } from 'zod'
import { CodingWorkspaceError, workspaceReadRequest } from '@mikka/protocol/coding-workspace'
import { auth } from '@/lib/api-auth'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { requestWorkspaceRead } from '@/lib/coding-workspace/requests'
import { writeRunFile, type FileWriteInput } from '@/lib/coding-workspace/files/write'
import { gitEnvelope, gitHttp } from '@/lib/coding-workspace/git/http'
import { workspaceReadResponse } from '@/lib/coding-workspace/response'
import { workspaceErrorStatus, workspaceSessionStillValid } from '@/lib/coding-workspace/http'

export const maxDuration = 30
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return Response.json({ ok: false, code: 'authRequired' }, { status: 401, headers })
  try {
    const runId = z.uuid().parse((await context.params).runId)
    const search = new URL(request.url).searchParams
    if ((search.has('source') && search.get('source') !== 'working') || search.has('ref'))
      throw new CodingWorkspaceError('workspace_unsupported')
    const repoId = z.uuid().parse(search.get('repoId'))
    const kind = search.get('kind') ?? 'tree'
    const input = workspaceReadRequest.parse(kind === 'search'
      ? { kind, query: search.get('query'), ...(search.has('limit') ? { limit: Number(search.get('limit')) } : {}) }
      : kind === 'file' ? { kind, path: search.get('path'), ...(search.has('headSha') || search.has('contentSha256')
        ? { expected: { headSha: search.get('headSha'), contentSha256: search.get('contentSha256') } } : {}), ...(search.has('startLine') || search.has('endLine')
        ? { range: { startLine: Number(search.get('startLine')), endLine: Number(search.get('endLine')) } } : {}) }
        : { kind, path: search.get('path') ?? '', ...(search.has('cursor') ? { cursor: search.get('cursor') } : {}), ...(search.has('limit') ? { limit: Number(search.get('limit')) } : {}) })
    const workspace = await loadWorkspaceContext(search.get('workspaceId') ?? undefined, session.user)
    const result = await requestWorkspaceRead(pool, workspacePool, { userId: session.user.id, workspaceId: workspace.workspace.id }, runId, repoId, input, request.signal)
    if (!await workspaceSessionStillValid(request, session)) return Response.json({ ok: false, code: 'authRequired' }, { status: 401, headers })
    if (result.ok) return await workspaceReadResponse(pool, workspacePool, request, session,
      { userId: session.user.id, workspaceId: workspace.workspace.id }, result, () => Response.json(result, { headers }))
    return Response.json(result, { status: result.ok ? 200 : workspaceErrorStatus(new CodingWorkspaceError(result.code)), headers })
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ ok: false, code: 'workspace_invalid_request' }, { status: 400, headers })
    if (error instanceof WorkspaceError) return Response.json({ ok: false, code: 'workspace_not_found' }, { status: 404, headers })
    if (error instanceof CodingWorkspaceError) return Response.json({ ok: false, code: error.code }, { status: workspaceErrorStatus(error), headers })
    throw error
  }
}

const writeCommand = gitEnvelope.extend({ operationId: z.uuid(), op: z.enum(['save', 'rename', 'delete']),
  path: z.string().min(1).max(1024), newPath: z.string().min(1).max(1024).optional(),
  expected: z.object({ exists: z.boolean(), contentSha256: z.string().nullable(), mode: z.enum(['100644', '100755']).nullable(),
    workingVersion: z.string().max(80).nullable().optional() }),
  encoding: z.enum(['utf8', 'base64']).optional(), content: z.string().max(1_398_104).optional(),
  executable: z.boolean().optional() })

/** saveRunFile CAS contract (#1728): 409 workspace_version_conflict when the
 * observed file no longer matches `expected`; the audit row and Undo capture
 * live on the shared operation ledger. */
export const POST = gitHttp(async ({ actor, input, runId, repoId, request }) => {
  const value = writeCommand.parse(input)
  if ((value.op === 'save') !== (value.content !== undefined && value.encoding !== undefined))
    throw new CodingWorkspaceError('workspace_invalid_request')
  if (value.op === 'rename' && !value.newPath) throw new CodingWorkspaceError('workspace_invalid_request')
  if (value.op !== 'rename' && value.newPath) throw new CodingWorkspaceError('workspace_invalid_request')
  const op: FileWriteInput = value.op === 'save'
    ? { kind: 'save', operationId: value.operationId, path: value.path, expected: { workingVersion: null, ...value.expected },
      encoding: value.encoding!, content: value.content!, executable: value.executable }
    : value.op === 'rename'
      ? { kind: 'rename', operationId: value.operationId, path: value.path, newPath: value.newPath!, expected: { workingVersion: null, ...value.expected } }
      : { kind: 'delete', operationId: value.operationId, path: value.path, expected: { workingVersion: null, ...value.expected } }
  return { value: await writeRunFile({ database: pool, membership: workspacePool }, actor, runId, repoId, op, request.signal) }
}, { bodyBytes: 2 * 1024 * 1024 })
