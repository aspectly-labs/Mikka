import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { PaidResourceError } from '../../abuse/policy'
import { hostedSnapshot, type TaskMachineActor } from '../../cloud-computer/sponsored-task'
import { fundMachineChunk } from '../../cloud-computer/machine-billing'
import { DEFAULT_MACHINE_SIZE, isMachineSize, MACHINE_CHUNK_MS } from '../../cloud-computer/machine-pricing'
import { openOwnedCloudflareTaskMachine, releaseOwnedCloudflareTaskMachine } from '../cloudflare-task-bridge'
import { jsonbSafeIntSql } from '../../primitives/jsonb-predicates'
import { eveFactoryRefusal } from './contract'
import type { SandboxConnection } from 'eve/sandbox/provider'

/**
 * #3082: machine custody for an Eve Factory role turn. The native sponsored
 * lifecycle (`reserve`) spawns the Mikka worker inside the machine and rebinds
 * device credentials; an Eve role needs none of that — its session's sandbox
 * connection IS the executor. This path still pays for the machine through
 * the same machine-billing chunks, still writes the same thread_machines
 * lease fields the grant machinery requires, and still parks the container at
 * turn end so provider/approval/CI waits hold no compute.
 */
export async function openEveFactoryMachine(
  pool: Pool, actor: TaskMachineActor, runId: string,
): Promise<{ connection: SandboxConnection; operationId: string }> {
  const tx = await pool.connect()
  let handoff: { operationId: string; index: number; size: string } | null
  try {
    await tx.query('BEGIN')
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['eve-factory-machine:' + runId])
    const { rows: [row] } = await tx.query<{
      state: string; sandboxId: string | null; sponsoredUntil: Date | null; sponsoredChunks: number | null
      sponsoredSize: string | null; operationId: string
    }>(
      `SELECT m.state,m."sandboxId",(m.lifecycle->>'sponsoredUntil')::timestamptz AS "sponsoredUntil",
        ${jsonbSafeIntSql('m.lifecycle', 'sponsoredChunks')} AS "sponsoredChunks",m.lifecycle->>'sponsoredSize' AS "sponsoredSize",
        m."operationId"
       FROM thread_machines m
       JOIN agent_runs r ON r.id=m."runId" AND r."userId"=m."ownerId" AND r."workspaceId"=m."workspaceId" AND r."issueId"=m."issueId"
       WHERE m."runId"=$1 AND m."ownerId"=$2 AND m."workspaceId"=$3 AND m."snapshotId"=$4
         AND r.status='queued' AND r."stopRequestedAt" IS NULL
       FOR UPDATE OF m`,
      [runId, actor.userId, actor.workspaceId, hostedSnapshot],
    )
    if (!row) { await tx.query('COMMIT'); handoff = null }
    else if (row.state === 'running' && row.sandboxId && row.sponsoredUntil && row.sponsoredUntil.getTime() > Date.now()) {
      await tx.query('COMMIT'); handoff = null
    } else {
      const size = isMachineSize(row.sponsoredSize ?? undefined) ? row.sponsoredSize! : DEFAULT_MACHINE_SIZE
      handoff = { operationId: randomUUID(), index: (row.sponsoredChunks ?? 0), size }
      await tx.query(
        `UPDATE thread_machines SET state='starting',"operationId"=$2,"sandboxId"=NULL,
          "workerLeaseUntil"=clock_timestamp()+make_interval(secs=>$4::double precision/1000),"lifecycleAt"=clock_timestamp(),
          lifecycle=lifecycle||jsonb_build_object('phase','eve_role_open','sponsoredUntil',clock_timestamp()+make_interval(secs=>$4::double precision/1000),'sponsoredChunks',$5::int,'sponsoredSize',$6::text)
         WHERE "runId"=$1 AND "operationId"=$3`,
        [runId, handoff.operationId, row.operationId, MACHINE_CHUNK_MS, handoff.index + 1, size],
      )
      await tx.query('COMMIT')
    }
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    tx.release()
  }
  if (handoff) {
    if (!await fundMachineChunk({
      ownerId: actor.userId, workspaceId: actor.workspaceId, runId,
      operationId: handoff.operationId, index: handoff.index,
      size: handoff.size as typeof DEFAULT_MACHINE_SIZE,
    })) throw new PaidResourceError('points_exhausted')
    try {
      const opened = await openOwnedCloudflareTaskMachine(pool, actor, runId)
      await pool.query(
        `UPDATE thread_machines SET state='running',"sandboxId"=$2,"runningSince"=clock_timestamp() WHERE "runId"=$1 AND "operationId"=$3 AND state='starting'`,
        [runId, opened.instanceId, handoff.operationId],
      )
      return { connection: opened.connection, operationId: handoff.operationId }
    } catch (error) {
      await pool.query(
        `UPDATE thread_machines SET state='error',"workerLeaseUntil"=NULL,"lifecycleAt"=now() WHERE "runId"=$1 AND "operationId"=$2`,
        [runId, handoff.operationId],
      ).catch(() => {})
      throw error
    }
  }
  const opened = await openOwnedCloudflareTaskMachine(pool, actor, runId)
  const { rows: [machine] } = await pool.query<{ operationId: string }>(
    `SELECT "operationId" FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "snapshotId"=$4`,
    [runId, actor.userId, actor.workspaceId, hostedSnapshot],
  )
  if (!machine) throw eveFactoryRefusal('eveFactoryComputeUnavailable')
  return { connection: opened.connection, operationId: machine.operationId }
}

/**
 * Park the role's machine at turn end: checkpoint the workspace, release the
 * container and leave a `sponsoredRestore` manifest the next role's open can
 * resume. Waiting for provider, approval or CI then holds no compute.
 */
/** Host-owned observations taken inside the still-open machine — never
 * agent-supplied. The worktree head, the pushed branch ref, the working-tree
 * status and the frozen verify command's actual exit result. A null field is
 * an honest missing observation, never an invented pass. */
export interface EveFactoryHostEvidence {
  headSha: string | null
  /** The remote ref's sha for the task branch, when it could be listed. */
  branchRefSha: string | null
  /** `git status --porcelain` paths — for the reviewer this must stay empty. */
  filesChanged: string[]
  verify: {
    status: 'passed' | 'failed' | 'not_run'
    command?: string
    exitCode?: number | null
    signal?: string | null
    timedOut?: boolean
    output?: string
  }
}

const sha = (text: string | null | undefined) =>
  text && /^[a-f0-9]{40}$/.test(text.trim()) ? text.trim() : null

async function spawnCapture(connection: SandboxConnection, command: string, workingDirectory: string, timeoutMs: number) {
  const proc = await connection.spawn({ command, env: {}, workingDirectory, signal: AbortSignal.timeout(timeoutMs) })
  const drain = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text()
  const [stdout, stderr, done] = await Promise.all([drain(proc.stdout), drain(proc.stderr), proc.wait()])
  return { exitCode: done.exitCode, output: `${stdout}\n${stderr}`.slice(-10_000) }
}

/**
 * #3082: collect the host-owned run evidence on an open role-machine
 * connection. `git` here runs inside the sandbox like the role's own tools;
 * the difference is that this caller is the adapter, so the resulting fields
 * are daemon-equivalent facts the RunReport's daemon-owned slots require.
 */
export async function captureEveFactoryHostEvidence(
  connection: SandboxConnection,
  input: { repoDir?: string; branch?: string | null; verifyCommand?: string | null; verifyTimeoutMs?: number },
): Promise<EveFactoryHostEvidence> {
  const dir = input.repoDir ?? '/workspace/repo'
  const evidence: EveFactoryHostEvidence = { headSha: null, branchRefSha: null, filesChanged: [], verify: { status: 'not_run' } }
  const safe = async (command: string, timeoutMs: number) => {
    try { return await spawnCapture(connection, command, dir, timeoutMs) }
    catch { return null }
  }
  evidence.headSha = sha((await safe('git rev-parse HEAD', 15_000))?.output.trim().split('\n').at(-1))
  const status = await safe('git status --porcelain', 15_000)
  if (status) evidence.filesChanged = status.output.split('\n').map(line => line.replace(/^[ MADRCU?!]{1,2}\s+/, '').trim()).filter(line => line && !line.startsWith('.')).slice(0, 200)
  if (input.branch) {
    const remote = await safe(`git ls-remote origin "refs/heads/${input.branch.replace(/"/g, '')}"`, 20_000)
    evidence.branchRefSha = sha(remote?.output.trim().split(/\s+/)[0])
  }
  if (input.verifyCommand) {
    try {
      const result = await spawnCapture(connection, input.verifyCommand, dir, input.verifyTimeoutMs ?? 120_000)
      evidence.verify = {
        status: result.exitCode === 0 ? 'passed' : 'failed', command: input.verifyCommand.slice(0, 2_000),
        exitCode: result.exitCode, signal: null, timedOut: false, output: result.output.slice(0, 10_000),
      }
    } catch (error) {
      evidence.verify = {
        status: 'failed', command: input.verifyCommand.slice(0, 2_000), exitCode: null,
        signal: null, timedOut: error instanceof Error && error.name === 'AbortError',
        output: String(error instanceof Error ? error.message : error).slice(0, 2_000),
      }
    }
  }
  return evidence
}

export async function releaseEveFactoryMachine(
  pool: Pool, actor: TaskMachineActor, runId: string, operationId: string,
) {
  const checkpoint = await releaseOwnedCloudflareTaskMachine(pool, actor, runId, operationId)
  await pool.query(
    `UPDATE thread_machines SET state='paused',
      "computeSeconds"="computeSeconds"+GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")))::bigint,
      "runningSince"=NULL,"workerLeaseUntil"=NULL,"lifecycleAt"=now(),
      lifecycle=lifecycle||jsonb_build_object('phase','eve_role_parked','sponsoredUntil',NULL::timestamptz)
        ||CASE WHEN $3::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sponsoredRestore',$3::jsonb) END
     WHERE "runId"=$1 AND "operationId"=$2 AND state<>'ended'`,
    [runId, operationId, checkpoint ? JSON.stringify(checkpoint) : null],
  )
}
