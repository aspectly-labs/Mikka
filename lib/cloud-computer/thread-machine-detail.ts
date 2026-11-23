import 'server-only'
import { Sandbox, SandboxNotFoundError } from 'e2b'
import type { Pool } from 'pg'
import { ComputerError } from '@/lib/computer/store'
import { cloudMachineState, type ThreadMachineState } from '@/lib/thread-machine'
import { e2bApiKey, withE2BErrors } from '@/lib/secrets/e2b-runtime'
import { readComputerMetrics } from '@/lib/computer/e2b-provider'
import type { Actor } from './subagents'

type MachineRow = {
  runId: string; sandboxId: string | null; snapshotId: string | null; state: string
  workerLeaseId: string | null; workerLeaseUntil: Date | string | null
  filesystemSnapshotId: string | null; snapshotTakenAt: Date | null; snapshotState: string
  createdAt: Date | null; lastActiveAt: Date | null; templateKind: string | null
}

type SessionRow = { startedAt: Date; endedAt: Date | null }

/** The Setup tab's machine detail for one thread (docs/design/thread-run-right-panel.md):
 * state, provider specs, the last metrics sample, session uptime and snapshot/setup recipe.
 * Everything it reports is read, never fabricated: provider calls that find a gone or paused
 * sandbox degrade that section, not the whole response. */
export async function readThreadMachineDetail(pool: Pool, actor: Actor, runId: string, signal: AbortSignal) {
  const machine = (await pool.query<MachineRow>(`SELECT m."runId",m."sandboxId",m."snapshotId",m.state,
      m."workerLeaseId",m."workerLeaseUntil",m."filesystemSnapshotId",m."snapshotTakenAt",m."snapshotState",
      m."createdAt",m."lastActiveAt",m."templateKind"
    FROM thread_machines m WHERE m."runId"=$1 AND m."ownerId"=$2 AND m."workspaceId"=$3`, [runId, actor.userId, actor.workspaceId])).rows[0]
  if (!machine) throw new ComputerError(404, 'Thread machine unavailable')

  const sessions = (await pool.query<SessionRow>(`SELECT "startedAt","endedAt" FROM thread_machine_sessions
    WHERE "runId"=$1 AND "ownerId"=$2 ORDER BY "startedAt" DESC`, [runId, actor.userId])).rows
  const uptimeSeconds = sessions.reduce((sum, row) => sum + Math.floor(((row.endedAt ?? new Date()).getTime() - new Date(row.startedAt).getTime()) / 1000), 0)
  const runningSession = sessions.find(row => !row.endedAt)

  const run = (await pool.query<{ agentDefinition: { projectExecution?: { environment?: { id?: string; name?: string; setup?: { command?: string; copyFiles?: string[]; approved?: boolean } | null } } } | null }>(
    `SELECT "agentDefinition" FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3`, [runId, actor.userId, actor.workspaceId])).rows[0]
  const environment = run?.agentDefinition?.projectExecution?.environment

  const state: ThreadMachineState = cloudMachineState(machine.state, { sandboxId: machine.sandboxId, workerLeaseId: machine.workerLeaseId, workerLeaseUntil: machine.workerLeaseUntil })

  let sandbox: { state: string; startedAt: string | null; endAt: string | null; cpuCount: number | null; memoryMB: number | null; templateId: string | null } | null = null
  let metrics: { timestamp: string; cpuUsedPct: number; cpuCount: number; memUsed: number; memTotal: number; diskUsed: number; diskTotal: number } | null = null
  if (machine.sandboxId && state !== 'ended' && state !== 'error') {
    try {
      const apiKey = await e2bApiKey(actor.userId, 'Cloud computer is not configured')
      const info = await withE2BErrors(actor.userId, false, () => Sandbox.getInfo(machine.sandboxId!, { apiKey, timeoutMs: 10_000, requestTimeoutMs: 10_000, signal }))
      sandbox = { state: info.state, startedAt: info.startedAt?.toISOString() ?? null, endAt: info.endAt?.toISOString() ?? null,
        cpuCount: info.cpuCount ?? null, memoryMB: info.memoryMB ?? null, templateId: info.templateId ?? null }
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) throw error
    }
    try {
      const end = new Date()
      const start = runningSession?.startedAt ? new Date(runningSession.startedAt) : new Date(end.getTime() - 5 * 60_000)
      const samples = await readComputerMetrics(actor.userId, machine.sandboxId, start, end, signal)
      const latest = Array.isArray(samples) ? samples[samples.length - 1] : (samples as { metrics?: unknown[] }).metrics?.at(-1)
      const sample = latest as { timestamp?: Date; cpuUsedPct?: number; cpuCount?: number; memUsed?: number; memTotal?: number; diskUsed?: number; diskTotal?: number } | undefined
      if (sample && sample.timestamp) metrics = { timestamp: new Date(sample.timestamp).toISOString(), cpuUsedPct: sample.cpuUsedPct ?? 0,
        cpuCount: sample.cpuCount ?? 0, memUsed: sample.memUsed ?? 0, memTotal: sample.memTotal ?? 0, diskUsed: sample.diskUsed ?? 0, diskTotal: sample.diskTotal ?? 0 }
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) throw error
    }
  }

  return {
    runId,
    kind: 'cloud' as const,
    state,
    sandboxId: machine.sandboxId ? machine.sandboxId.slice(0, 6) : null,
    templateKind: machine.templateKind,
    createdAt: machine.createdAt ? new Date(machine.createdAt).toISOString() : null,
    lastActiveAt: machine.lastActiveAt ? new Date(machine.lastActiveAt).toISOString() : null,
    sandbox,
    metrics,
    uptimeSeconds,
    runningSince: runningSession ? new Date(runningSession.startedAt).toISOString() : null,
    snapshot: { filesystemSnapshotId: machine.filesystemSnapshotId, snapshotTakenAt: machine.snapshotTakenAt ? new Date(machine.snapshotTakenAt).toISOString() : null, state: machine.snapshotState },
    setup: environment?.setup ? { command: environment.setup.command ?? null, copyFiles: environment.setup.copyFiles ?? [], approved: environment.setup.approved === true } : null,
    environment: environment?.id ? { id: environment.id, name: environment.name ?? null } : null,
  }
}
