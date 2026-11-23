import type { Pool, PoolClient } from 'pg'
import { withDatabaseClient } from '../db/request-scope'
import { actingContext } from '../activity-actor'
import { tokenWorkspace } from '../tokens/principal'
import { runsOutsideToken } from '../tokens/scope'
import { RUN_CHAIN_MAX_DEPTH, runChainSql } from '../run-chain'
import { maskFactoryNote } from './note-mask'
import { executionRouteSchema, executionRouteForRun, type ExecutionRoute } from './execution-route'
import type { FactoryStage } from './contract'
import type { createFactoryStore, FactoryTask } from './store'

/**
 * #3087: the canonical Factory stage-execution envelope — one read shape per
 * stage attempt, assembled as a projection over the existing tables
 * (factory_tasks/factory_attempts, agent_runs, devices, factory_candidates,
 * thread_machines, run chains). It adds no lifecycle table and writes
 * nothing: every field is either stored state, the attempt's frozen
 * execution-route receipt (#3081), or an explicitly marked unavailable value.
 */

export const FACTORY_EXECUTION_VIEW_VERSION = 1 as const

type Instant = Date | string | null
const iso = (value: Instant | undefined) => value == null ? null : new Date(value).toISOString()
const text = (value: string | null, limit = 200) => value == null ? null : maskFactoryNote(value).slice(0, limit)
const githubPullRequest = (value: unknown): string | null => typeof value === 'string'
  && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(value) ? value : null

export interface FactoryExecutionArtifact {
  /** The evidence artifact reference or the published pull request URL. */
  ref: string
  kind: 'log' | 'report' | 'screenshot' | 'video' | 'request' | 'pull_request'
}

export interface FactoryStageExecution {
  /** FactoryTaskId / AttemptId / Stage / StageStatus: the Factory's own
   * identity and lifecycle, unchanged from the existing state machine. */
  taskId: string
  attemptId: string
  stage: FactoryStage
  stageStatus: string
  position: number
  candidateId: string | null
  /** RunId: the bound agent run, null before binding or when the bound run is
   * not the caller's (`runUnavailable` distinguishes the two). */
  runId: string | null
  runUnavailable: boolean
  /** ThreadId: the run's chain root (run-chain semantics over retryOf,
   * continuesRunId and question continuations); null when unbound. */
  threadId: string | null
  /** ExecutorKind/Place/Harness: from the attempt's frozen route receipt, or
   * derived from the run's own device/harness for older rows. */
  route: ExecutionRoute | null
  routeSource: 'recorded' | 'derived' | null
  executor: ExecutionRoute['executor'] | null
  place: ExecutionRoute['place'] | null
  harness: string | null
  provider: string | null
  model: string | null
  agent: { id: string; name: string | null } | null
  device: { id: string; name: string | null; kind: string | null } | null
  /** SourceSHA: the candidate's commit when the attempt produced or checked one. */
  sourceSha: string | null
  /** ArtifactRefs: evidence artifact refs plus the published PR URL. */
  artifacts: FactoryExecutionArtifact[]
  /** Cost: billed machine seconds from thread_machines; 'unavailable' when no
   * cloud machine row exists for the run (local daemon, pre-claim, Eve adapter). */
  cost: { source: 'thread_machines' | 'unavailable'; computeSeconds: number | null }
  /** Timers: attempt and run lifecycle timestamps. */
  timers: {
    attemptCreatedAt: string | null
    runQueuedAt: string | null
    runStartedAt: string | null
    runFinishedAt: string | null
    attemptFinishedAt: string | null
  }
}

export interface FactoryExecutionView {
  version: typeof FACTORY_EXECUTION_VIEW_VERSION
  task: {
    id: string
    issueId: string
    stage: FactoryStage
    status: string
    revision: number
    attemptId: string
    candidateId: string | null
  }
  executions: FactoryStageExecution[]
}

interface ExecutionRow {
  attemptId: string; stage: FactoryStage; stageStatus: string; position: number
  attemptCreatedAt: Instant; attemptFinishedAt: Instant
  candidateId: string | null; boundRunId: string | null; recordedRoute: unknown; evidence: unknown
  runId: string | null; runStatus: string | null; runCreatedAt: Instant; runStartedAt: Instant; runFinishedAt: Instant
  agentId: string | null; agentName: string | null; harness: string | null; model: string | null
  deviceId: string | null; deviceName: string | null; deviceKind: string | null
  candidateSha: string | null
  hasMachine: boolean; computeSeconds: string | number | null
}

const EVIDENCE_KINDS = new Set(['log', 'report', 'screenshot', 'video', 'request'])

function evidenceArtifacts(evidence: unknown): FactoryExecutionArtifact[] {
  if (!Array.isArray(evidence)) return []
  const artifacts: FactoryExecutionArtifact[] = []
  for (const entry of evidence) {
    if (!entry || typeof entry !== 'object') continue
    const { artifact, kind } = entry as { artifact?: unknown; kind?: unknown }
    if (typeof artifact === 'string' && artifact && typeof kind === 'string' && EVIDENCE_KINDS.has(kind))
      artifacts.push({ ref: artifact, kind: kind as FactoryExecutionArtifact['kind'] })
    if (artifacts.length >= 50) break
  }
  return artifacts
}

/** One authorized, repeatable-read snapshot; no model, transcript, secret or
 * object-store access, matching the activity read model. */
export async function readFactoryExecutionView(pool: Pool, store: Pick<ReturnType<typeof createFactoryStore>, 'readTask'>, userId: string, taskId: string): Promise<FactoryExecutionView> {
  const tx = await pool.connect()
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    const task = await store.readTask(tx, userId, taskId)
    const result = await withDatabaseClient(tx, () => projectFactoryExecution(tx, task))
    await tx.query('COMMIT')
    return result
  } catch (error) { await tx.query('ROLLBACK'); throw error }
  finally { tx.release() }
}

/** Caller has already applied the canonical owner/Bot/source/issue boundary. */
export async function projectFactoryExecution(tx: PoolClient, task: FactoryTask): Promise<FactoryExecutionView> {
  const { rows } = await tx.query<ExecutionRow>(`SELECT a.id AS "attemptId",a.stage,a.status AS "stageStatus",a.position,
      a."createdAt" AS "attemptCreatedAt",a."finishedAt" AS "attemptFinishedAt",
      a."candidateId",a."runId" AS "boundRunId",a.output->'executionRoute' AS "recordedRoute",a.evidence,
      r.id AS "runId",r.status AS "runStatus",r."createdAt" AS "runCreatedAt",r."startedAt",r."finishedAt" AS "runFinishedAt",
      r."agentId",left(COALESCE(r."agentDefinition"->'agentProfile'->>'name',r."agentDefinition"->>'name',agent.name),200) AS "agentName",
      left(COALESCE(r."agentDefinition"->>'harness',agent.harness),200) AS harness,left(r."agentDefinition"->>'model',200) AS model,
      device.id AS "deviceId",left(device.name,200) AS "deviceName",device.kind AS "deviceKind",
      c.sha AS "candidateSha",
      m."runId" IS NOT NULL AS "hasMachine",
      m."computeSeconds"+COALESCE(GREATEST(0,EXTRACT(EPOCH FROM (now()-m."runningSince")))::bigint,0) AS "computeSeconds"
    FROM factory_attempts a
    LEFT JOIN agent_runs r ON r.id=a."runId" AND r."userId"=$2 AND r."issueId"=$3
    LEFT JOIN agents agent ON agent.id=r."agentId" AND agent."userId"=$2
    LEFT JOIN devices device ON device.id=r."deviceId" AND device."ownerId"=$2
    LEFT JOIN factory_candidates c ON c.id=a."candidateId" AND c."taskId"=a."taskId"
    LEFT JOIN thread_machines m ON m."runId"=r.id AND m."ownerId"=$2
    WHERE a."taskId"=$1 ORDER BY a.position,a.id`, [task.id, task.userId, task.issueId])
  // Thread identity: each bound run's chain root, with the canonical run-chain
  // edges (retryOf, continuesRunId, question continuation) and depth fence.
  const { rows: roots } = await tx.query<{ runId: string; threadId: string; depthExceeded: boolean }>(
    `WITH RECURSIVE ${runChainSql('r."issueId"=$2 AND r."userId"=$3', '$4')}
     SELECT a.id::text AS "runId",a.root::text AS "threadId",a."depthExceeded"
     FROM assigned a JOIN factory_attempts attempt ON attempt."runId"=a.id AND attempt."taskId"=$1`,
    [task.id, task.issueId, task.userId, RUN_CHAIN_MAX_DEPTH])
  const threadByRun = new Map(roots.map(root => [root.runId, root]))
  const { rows: publications } = await tx.query<{ runId: string; url: string | null }>(
    `SELECT p."runId",p."pullRequest"->>'url' AS url
     FROM run_publications p JOIN factory_attempts a ON a."runId"=p."runId"
     WHERE a."taskId"=$1 AND p."userId"=$2 AND p."issueId"=$3 AND p.status='published' AND p."pullRequest" IS NOT NULL
     ORDER BY p."updatedAt",p."runId"`, [task.id, task.userId, task.issueId])
  const pullByRun = new Map(publications.map(row => [row.runId, githubPullRequest(row.url)]))
  const actor = actingContext.getStore()
  const scopedWorkspace = actor?.userId === task.userId ? actor.tokenWorkspaceId : undefined
  const hiddenRuns = scopedWorkspace ? await runsOutsideToken({ id: task.userId, [tokenWorkspace]: scopedWorkspace },
    rows.flatMap(row => row.boundRunId ? [row.boundRunId] : [])) : new Set<string>()
  // A bound run that fails the owner join is not the caller's run: its binding
  // and every run detail stay private, exactly as the activity model fences it.
  for (const row of rows) if (row.boundRunId && !row.runId) hiddenRuns.add(row.boundRunId)
  const executions: FactoryStageExecution[] = rows.map(row => {
    const runBound = row.boundRunId !== null && row.runId !== null && !hiddenRuns.has(row.boundRunId)
    const recorded = executionRouteSchema.safeParse(row.recordedRoute)
    let route: ExecutionRoute | null = recorded.success ? recorded.data : null
    let routeSource: FactoryStageExecution['routeSource'] = recorded.success ? 'recorded' : null
    if (!route && runBound) {
      try {
        route = executionRouteForRun({ deviceKind: row.deviceKind, harness: row.harness })
        routeSource = 'derived'
      } catch { route = null }
    }
    const thread = runBound ? threadByRun.get(row.runId!) : undefined
    const artifacts = evidenceArtifacts(row.evidence)
    const pull = runBound ? pullByRun.get(row.runId!) : null
    if (pull) artifacts.push({ ref: pull, kind: 'pull_request' })
    return {
      taskId: task.id,
      attemptId: row.attemptId,
      stage: row.stage,
      stageStatus: row.stageStatus,
      position: row.position,
      candidateId: row.candidateId,
      runId: runBound ? row.runId : null,
      runUnavailable: row.boundRunId !== null && !runBound,
      threadId: thread && !thread.depthExceeded ? thread.threadId : null,
      route,
      routeSource,
      executor: route?.executor ?? null,
      place: route?.place ?? null,
      harness: route?.harness ?? (runBound ? text(row.harness) : null),
      provider: route?.provider ?? null,
      model: runBound ? text(row.model) : null,
      agent: runBound && row.agentId ? { id: row.agentId, name: text(row.agentName) } : null,
      device: runBound && row.deviceId ? { id: row.deviceId, name: text(row.deviceName), kind: row.deviceKind } : null,
      sourceSha: row.candidateSha,
      artifacts,
      cost: runBound && row.hasMachine
        ? { source: 'thread_machines' as const, computeSeconds: row.computeSeconds == null ? null : Number(row.computeSeconds) }
        : { source: 'unavailable' as const, computeSeconds: null },
      timers: {
        attemptCreatedAt: iso(row.attemptCreatedAt),
        runQueuedAt: runBound ? iso(row.runCreatedAt) : null,
        runStartedAt: runBound ? iso(row.runStartedAt) : null,
        runFinishedAt: runBound ? iso(row.runFinishedAt) : null,
        attemptFinishedAt: iso(row.attemptFinishedAt),
      },
    }
  })
  return {
    version: FACTORY_EXECUTION_VIEW_VERSION,
    task: { id: task.id, issueId: task.issueId, stage: task.stage, status: task.status, revision: task.revision, attemptId: task.attemptId, candidateId: task.candidateId },
    executions,
  }
}
