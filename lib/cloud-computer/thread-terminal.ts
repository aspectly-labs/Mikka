import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { TerminalError, terminalInputSchema, terminalResizeSchema, TERMINAL_INPUT_BYTES } from '@mikka/protocol/coding-terminal'
import { getApiSession, apiWorkspaceAllowed, type ApiSession } from '@/lib/api-auth'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { ReviewAuthorityError, credentialOf, lockCredential, type TaskReviewAuthority, type ReviewAuthorityExpectation } from '@/lib/coding-workspace/review-authority'
import { beginReviewSession, readReviewSession, closeReviewSession, revokeReviewSession, listReviewSessions } from '@/lib/coding-workspace/review-sessions'
import { prepareTerminal, existingTerminal, terminalRequest } from '@/lib/coding-workspace/terminal/runtime'
import { terminalGrant } from '@/lib/coding-workspace/terminal/wire'
import { HEADERS, origin, body, failure, relayTerminal } from '@/lib/coding-workspace/terminal/http'
import { hostedSnapshot } from './sponsored-task'

/** #2940: an owner's terminal on the thread's own machine. Unlike a task-review
 * terminal it runs beside the executor — the ticket carries control:'thread',
 * which the gateway honours by skipping the daemon lock + idle receipt (that
 * fence exists for review provenance, not for the owner's own box). */
export type ThreadTerminalScope = TaskReviewAuthority & { threadTerminal: true }

type MachineRow = {
  issueId: string; worktreePath: string | null; runStatus: string; startedAt: Date | null
  pauseReason: string | null; leaseExpiresAt: Date | null; deviceTokenId: string | null
  sandboxId: string | null; snapshotId: string | null; deviceId: string | null; repoId: string | null
  epoch: number; operationId: string; state: string; repoPath: string | null
}

async function authenticated(request: Request): Promise<{ session: ApiSession; workspaceId: string }> {
  const session = await getApiSession({ headers: request.headers })
  if (!session?.user?.id) throw new ReviewAuthorityError('review_auth_required')
  const context = await loadWorkspaceContext(undefined, session.user)
  const workspaceId = context.workspace.id
  if (!apiWorkspaceAllowed(session, workspaceId)) throw new ReviewAuthorityError('review_scope_denied')
  return { session, workspaceId }
}

async function loadScope(client: PoolClient, session: ApiSession, workspaceId: string, runId: string): Promise<ThreadTerminalScope> {
  const credential = credentialOf(session)
  const credentialExpiresAt = await lockCredential(client, session, credential)
  const { rows: [row] } = await client.query<MachineRow>(
    `SELECT r."issueId",r."worktreePath",r.status AS "runStatus",r."startedAt",r."pauseReason",r."leaseExpiresAt",r."deviceTokenId",
      m."sandboxId",m."snapshotId",m."deviceId",m."repoId",m.epoch,m."operationId",m.state,repo."repoPath"
    FROM thread_machines m
    JOIN agent_runs r ON r.id=m."runId" AND r."userId"=m."ownerId" AND r."workspaceId"=m."workspaceId"
    LEFT JOIN device_repos repo ON repo.id=m."repoId" AND repo."userId"=m."ownerId"
    WHERE m."runId"=$1 AND m."ownerId"=$2 AND m."workspaceId"=$3 FOR SHARE OF m`,
    [runId, session.user.id, workspaceId])
  if (!row) throw new ReviewAuthorityError('review_not_found')
  if (row.runStatus === 'stopped' || row.runStatus === 'cancelled') throw new ReviewAuthorityError('review_machine_gone')
  // Never wake billable compute: a thread terminal only attaches to a running machine.
  if (row.state !== 'running') throw new TerminalError('terminal_unavailable', { detail: 'machine_state' })
  // A Cloudflare-sponsored machine never takes the owner's E2B key; its terminal
  // rides the sponsored review path instead.
  if (row.snapshotId === hostedSnapshot) throw new TerminalError('terminal_unsupported', { detail: 'sponsored' })
  if (!row.sandboxId || !row.deviceId || !row.repoId || !row.worktreePath || !row.deviceTokenId)
    throw new TerminalError('terminal_unsupported', { detail: 'binding' })
  const bindingId = createHash('sha256').update(JSON.stringify(['thread', runId, workspaceId, session.user.id, row.issueId,
    row.deviceId, row.repoId, row.repoPath, row.worktreePath, row.sandboxId, row.epoch, row.operationId])).digest('hex')
  return {
    taskId: row.issueId, runId, userId: session.user.id, ownerId: session.user.id, workspaceId,
    deviceId: row.deviceId, repoId: row.repoId, deviceTokenId: row.deviceTokenId,
    remoteKey: row.repoPath ?? '', repoPath: row.repoPath ?? '', worktreePath: row.worktreePath,
    machineKind: 'cloud', sandboxId: row.sandboxId, machineEpoch: row.epoch, machineOperationId: row.operationId,
    machineStatus: row.state, runStatus: row.runStatus, runStartedAt: row.startedAt?.toISOString() ?? null,
    pauseReason: row.pauseReason, leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    nativeExitedProof: false, bindingId, deviceTokenActive: true, credential, credentialExpiresAt, threadTerminal: true,
  }
}

async function resolve<T>(pool: Pool, request: Request, runId: string, expected: ReviewAuthorityExpectation,
  work?: (scope: ThreadTerminalScope, client: PoolClient) => Promise<T>): Promise<T | ThreadTerminalScope> {
  if (!z.uuid().safeParse(runId).success) throw new ReviewAuthorityError('review_not_found')
  const { session, workspaceId } = await authenticated(request)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='20s'")
    const scope = await loadScope(client, session, workspaceId, runId)
    if (expected.bindingId && expected.bindingId !== scope.bindingId) throw new ReviewAuthorityError('review_binding_changed')
    const value = work ? await work(scope, client) : scope
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
}

type Dependencies = {
  authority: (request: Request, runId: string) => Promise<ThreadTerminalScope>
  authorized: <T>(request: Request, runId: string, work: (scope: ThreadTerminalScope, client: PoolClient) => Promise<T>, expected?: ReviewAuthorityExpectation) => Promise<T>
  begin: typeof beginReviewSession; read: typeof readReviewSession; close: typeof closeReviewSession
  revoke: typeof revokeReviewSession; list: typeof listReviewSessions
  prepare: typeof prepareTerminal; existing: typeof existingTerminal
  request: typeof terminalRequest; grant: typeof terminalGrant
}

export function threadTerminalHandlers(deps: Dependencies): {
  stream: (request: Request, runId: string) => Promise<Response>
  list: (request: Request, runId: string) => Promise<Response>
  input: (request: Request, runId: string) => Promise<Response>
  resize: (request: Request, runId: string) => Promise<Response>
  close: (request: Request, runId: string) => Promise<Response>
} {
  const expectOf = (scope: ThreadTerminalScope): ReviewAuthorityExpectation => ({ runId: scope.runId, bindingId: scope.bindingId })

  const stream = async (request: Request, runId: string) => {
    let opened: { scope: ThreadTerminalScope; lease: { id: string; expiresAt: string } } | undefined
    try {
      origin(request, true)
      const name = new URL(request.url).searchParams.get('name') ?? ''
      const initial = await deps.authority(request, runId)
      opened = await deps.authorized(request, runId, async (scope, client) => ({ scope,
        lease: await deps.begin(scope, { kind: 'terminal', name }, client) }), expectOf(initial))
      const prepared = await deps.prepare(opened.scope, request.signal, opened.lease)
      const admitted = await deps.authorized(request, runId, async (scope, client) => {
        const lease = await deps.read(scope, { kind: 'terminal', id: opened!.lease.id, name }, client)
        if (!lease) throw new TerminalError('terminal_ended')
        return { scope, lease, ticket: deps.grant(prepared, scope, lease, 'stream') }
      }, expectOf(initial))
      const abort = new AbortController()
      const signal = AbortSignal.any([request.signal, abort.signal])
      const upstream = await deps.request(prepared, 'stream', admitted.ticket, '', signal)
      const events = relayTerminal(upstream, () => deps.close(admitted.scope, { kind: 'terminal', id: admitted.lease.id, name }), abort)
      return new Response(events, { headers: { ...HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no', 'X-Terminal-Session-Id': admitted.lease.id } })
    } catch (error) {
      if (opened) await deps.revoke(opened.scope, { kind: 'terminal', id: opened.lease.id }).catch(() => undefined)
      return failure(error)
    }
  }

  const list = async (request: Request, runId: string) => {
    try {
      origin(request)
      const scope = await deps.authority(request, runId)
      return Response.json({ terminals: await deps.list(scope) }, { headers: HEADERS })
    } catch (error) { return failure(error) }
  }

  const control = async (request: Request, runId: string, operation: 'input' | 'resize') => {
    try {
      origin(request)
      let value: unknown = {}
      let requestId: string | undefined
      {
        value = await body(request)
        if (operation === 'input') {
          if (value && typeof value === 'object' && 'data' in value && typeof value.data === 'string'
            && Buffer.byteLength(value.data) > TERMINAL_INPUT_BYTES) throw new TerminalError('terminal_input_too_large')
          const parsed = terminalInputSchema.safeParse(value)
          if (!parsed.success) throw new TerminalError('terminal_invalid_request')
          requestId = parsed.data.requestId ?? randomUUID()
          value = { ...parsed.data, requestId }
        } else {
          const parsed = terminalResizeSchema.safeParse(value)
          if (!parsed.success) throw new TerminalError('terminal_invalid_request')
          value = parsed.data
        }
      }
      const scope = await deps.authority(request, runId)
      const name = new URL(request.url).searchParams.get('name') ?? ''
      const prepared = await deps.existing(scope, request.signal)
      const payload = JSON.stringify(value)
      const admitted = await deps.authorized(request, runId, async (current, client) => {
        const lease = await deps.read(current, { kind: 'terminal', name }, client)
        if (!lease) throw new TerminalError('terminal_ended')
        return { scope: current, lease, ticket: deps.grant(prepared, current, lease, operation, payload) }
      }, expectOf(scope))
      const response = await deps.request(prepared, operation, admitted.ticket, payload, request.signal)
      await response.body?.cancel()
      return new Response(null, { status: 204, headers: { ...HEADERS, ...(requestId ? { 'X-Terminal-Request-Id': requestId } : {}) } })
    } catch (error) { return failure(error) }
  }

  const close = async (request: Request, runId: string) => {
    try {
      origin(request)
      const name = new URL(request.url).searchParams.get('name') ?? ''
      const current = await deps.authorized(request, runId, async (scope, client) => ({ scope,
        lease: await deps.read(scope, { kind: 'terminal', name }, client) }))
      if (current.lease) {
        const result = await deps.revoke(current.scope, { kind: 'terminal', id: current.lease.id })
        if (result.pending) throw new TerminalError('terminal_unavailable', { detail: 'runtime' })
      }
      return new Response(null, { status: 204, headers: HEADERS })
    } catch (error) { return failure(error) }
  }

  return { stream, list, input: (request, runId) => control(request, runId, 'input'),
    resize: (request, runId) => control(request, runId, 'resize'), close }
}

export function threadTerminalRuntime(pool: Pool): Dependencies {
  return {
    authority: (request, runId) => resolve(pool, request, runId, {}) as Promise<ThreadTerminalScope>,
    authorized: (request, runId, work, expected = {}) => resolve(pool, request, runId, expected, work) as Promise<Awaited<ReturnType<typeof work>>>,
    begin: beginReviewSession, read: readReviewSession, close: closeReviewSession, revoke: revokeReviewSession,
    list: listReviewSessions, prepare: prepareTerminal, existing: existingTerminal, request: terminalRequest, grant: terminalGrant,
  }
}
