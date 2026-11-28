import 'server-only'
import { e2bResourceAccount } from '@/lib/secrets/e2b-resource'
import { z } from 'zod'
import type { Pool } from 'pg'
import { getApiSession, apiWorkspaceAllowed } from '@/lib/api-auth'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { ComputerError } from '@/lib/computer/store'
import { hostedSnapshot } from './sponsored-task'
import { Sandbox } from 'e2b'
import { connectComputer, computerGone } from '@/lib/computer/e2b-provider'
import { withE2BErrors } from '@/lib/secrets/e2b-runtime'

export type ThreadFileStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed'

/** One file the thread's run touched (#2940 Files tab「This thread」). */
export type ThreadTouchedFile = { path: string; status: ThreadFileStatus; committed: boolean }

function porcelainStatus(code: string): ThreadFileStatus {
  if (code.includes('R')) return 'renamed'
  if (code.includes('A')) return 'added'
  if (code.includes('D')) return 'deleted'
  if (code === '??') return 'untracked'
  return 'modified'
}

/** Parses raw `git status --porcelain=v1 -z` output. With `-z` a rename or
 * copy emits the from-path as the record after the status line, so no ` -> `
 * separator or quoting ever appears in real filenames. */
export function parsePorcelain(output: string): ThreadTouchedFile[] {
  const files: ThreadTouchedFile[] = []
  const records = output.split('\0')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length < 4) continue
    const code = record.slice(0, 2)
    if (code === '!!') continue
    files.push({ path: record.slice(3), status: porcelainStatus(code), committed: false })
    if (code.includes('R') || code.includes('C')) index += 1
  }
  return files
}

/** The thread's touched files: a live `git status` of the running machine's
 * worktree when one is attached, the frozen `report.filesChanged` otherwise.
 * Never fabricates — an unavailable live read degrades to the report. */
export async function readThreadTouchedFiles(pool: Pool, actor: { userId: string; workspaceId: string }, runId: string, signal: AbortSignal) {
  if (!z.uuid().safeParse(runId).success) throw new ComputerError(404, 'Thread unavailable')
  const run = (await pool.query<{ worktreePath: string | null; filesChanged: unknown }>(
    `SELECT r."worktreePath",r.report->'filesChanged' AS "filesChanged" FROM agent_runs r
    WHERE r.id=$1 AND r."userId"=$2 AND r."workspaceId"=$3`,
    [runId, actor.userId, actor.workspaceId])).rows[0]
  if (!run) throw new ComputerError(404, 'Thread unavailable')

  const machine = (await pool.query<{ sandboxId: string | null; snapshotId: string | null; state: string }>(
    `SELECT "sandboxId","snapshotId",state FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3`,
    [runId, actor.userId, actor.workspaceId])).rows[0]

  // Live projection first: the running sandbox answers `git status`. A
  // sponsored machine never takes the owner's E2B key, so it skips to the
  // frozen report below.
  if (machine?.sandboxId && machine.state === 'running' && machine.snapshotId !== hostedSnapshot && run.worktreePath) {
    try {
      // The database can still say `running` while the provider has already
      // paused the VM; `Sandbox.connect` would billably resume it. getInfo is
      // a pure read, so only a sandbox the provider itself reports running is
      // worth connecting to.
      const apiKey = (await e2bResourceAccount(actor.userId, 'sandbox', machine.sandboxId)).apiKey
      const info = await withE2BErrors(actor.userId, false, () => Sandbox.getInfo(machine.sandboxId!, { apiKey, requestTimeoutMs: 10_000, signal }))
      if (info.state === 'running') {
        const sandbox = await connectComputer(actor.workspaceId, machine.sandboxId, signal)
        const result = await sandbox.commands.run('git status --porcelain=v1 -z', { cwd: run.worktreePath, timeoutMs: 30_000, signal })
        if (result.exitCode === 0) return { files: parsePorcelain(result.stdout), source: 'live' as const }
      }
    } catch (error) {
      if (!computerGone(error)) throw error
    }
  }

  // `report.filesChanged` diffs the worktree against the base commit; a run
  // that stopped with dirty paths still lists them, so nothing here can be
  // claimed committed.
  const changed = Array.isArray(run.filesChanged) ? run.filesChanged.filter((f): f is string => typeof f === 'string') : []
  return { files: changed.map(path => ({ path, status: 'modified' as const, committed: false })), source: 'report' as const }
}

export async function threadFilesRoute(request: Request, pool: Pool, runId: string) {
  try {
    const session = await getApiSession({ headers: request.headers })
    if (!session?.user?.id) return Response.json({ error: 'auth_required' }, { status: 401 })
    const context = await loadWorkspaceContext(undefined, session.user)
    if (!apiWorkspaceAllowed(session, context.workspace.id)) return Response.json({ error: 'forbidden' }, { status: 403 })
    const result = await readThreadTouchedFiles(pool, { userId: session.user.id, workspaceId: context.workspace.id }, runId, request.signal)
    return Response.json(result)
  } catch (error) {
    if (error instanceof ComputerError) return Response.json({ error: error.message }, { status: error.status })
    throw error
  }
}
