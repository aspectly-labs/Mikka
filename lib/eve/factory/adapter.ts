import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { FactoryError, type FactoryStage } from '../../factory/contract'
import { defaultFactoryDispatchAdapters, type FactoryDispatchAdapters, type FactoryQueue } from '../../factory/dispatch'
import { queueFactoryTask } from '../../factory/task-dispatch'
import { cloudTaskTarget } from '../../computer/cloud-task-target'
import { runPromptParts } from '../../run-prompt'
import { tiptapToText } from '../../tiptap-text'
import { freezeWorkerDefinition, type WorkerDefinitionSnapshot } from '../../agent-kit/worker'
import { workerDefinitionDigest } from '../../agent-kit/worker-digest'
import { freezeExecutionIdentity } from '../../execution-identity'
import { hostedSnapshot } from '../../cloud-computer/sponsored-task'
import { internalEveHeaders } from '../auth'
import { eveInternalOrigin } from '../server-client'
import {
  EVE_FACTORY_CONTRACT_VERSION,
  EVE_FACTORY_EXECUTOR,
  eveFactoryRefusal,
  isEveFactoryDefinition,
  readEveFactoryPlan,
  recordEveFactoryRoute,
  type EveFactoryDispatchRole,
  type EveFactoryPlan,
} from './contract'
import { admitEveFactoryProvider, assertEveFactoryRoleCapability } from './providers'
import { eveFactoryRoleInstructions } from './session'
import { eveFactoryReportFor, eveFactoryResultFromMessages, type EveFactoryReportHost, type EveFactoryRoleResult } from './evidence'
import type { EveTurnSettlement } from '../settlement'
import type { EveScope } from '../scope'

type Actor = { userId: string; workspaceId: string }

/** The role's provider/model selection frozen onto the task at intake. */
function taskEveSelection(task: { route?: unknown }): { provider: string; model: string | null; effort: string | null } | null {
  const eve = task.route && typeof task.route === 'object'
    ? (task.route as Record<string, unknown>).eveFactory : undefined
  if (!eve || typeof eve !== 'object') return null
  const record = eve as Record<string, unknown>
  return typeof record.provider === 'string' ? {
    provider: record.provider,
    model: typeof record.model === 'string' ? record.model : null,
    effort: typeof record.effort === 'string' ? record.effort : null,
  } : null
}

const eveRoleKind: Record<EveFactoryDispatchRole, string> = {
  analyst: 'plan', implementer: 'implement', reviewer: 'acceptance',
}

/** Stage → dispatched role. `verify` reuses the read-only reviewer principal:
 * the role identity is the independent check executor; the stage and its
 * assignment stay distinct on the attempt. `clarify`/`approval`/`publish`/
 * `monitor` never dispatch an Eve role. */
function stageDispatchRole(stage: FactoryStage): EveFactoryDispatchRole | null {
  switch (stage) {
    case 'spec': return 'analyst'
    case 'execute': return 'implementer'
    case 'review':
    case 'verify': return 'reviewer'
    default: return null
  }
}

/** Deterministic run id, identical to queueCloudRun's `factory:` idempotency. */
function eveRunId(userId: string, attemptId: string) {
  const digest = createHash('sha256').update(JSON.stringify([userId, `factory:${attemptId}`])).digest('hex')
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

/**
 * #3082: the FactoryQueue for `cloud.eve_factory`. Runs inside the dispatch
 * transaction after the attempt exists and before configure/freeze — so the
 * route receipt, role plan, queued Run and machine placement share one commit.
 * A missing/unfit provider or role fails the whole dispatch; there is no
 * fallback to a native harness.
 */
export const queueEveFactoryStageRun: FactoryQueue = async (tx, userId, input, _botId, context) => {
  const { rows: [task] } = await tx.query<{
    id: string; userId: string; issueId: string; botId: string | null; stage: FactoryStage; route: unknown; sourceEventId: string
  }>(
    `SELECT t.id,t."userId",t."issueId",t."botId",t.stage,t.route,t."sourceEventId" FROM factory_attempts a
     JOIN factory_tasks t ON t.id=a."taskId" WHERE a.id=$1 AND t."userId"=$2`,
    [context.attemptId, userId],
  )
  const stage = context.stage ?? task?.stage
  const role = stage ? stageDispatchRole(stage) : null
  if (!task || !role) eveFactoryRefusal('eveFactoryRouteMismatch')
  const selection = taskEveSelection(task)
  if (!selection) eveFactoryRefusal('eveFactoryProviderUnavailable')
  const { descriptor, model, effort } = admitEveFactoryProvider({
    provider: selection.provider,
    ...(selection.model ? { model: selection.model } : {}),
    ...(selection.effort ? { effort: selection.effort } : {}),
  })
  const capabilityLimitations = assertEveFactoryRoleCapability(descriptor, role)

  const { rows: [issue] } = await tx.query<{ title: string; content: unknown; workspaceId: string }>(
    `SELECT title,content,"workspaceId" FROM issues WHERE id=$1 AND "userId"=$2`, [task.issueId, userId])
  if (!issue || !task.botId) eveFactoryRefusal('eveFactoryRouteMismatch')
  const actor: Actor = { userId, workspaceId: issue.workspaceId }
  const target = await cloudTaskTarget(tx, actor, { botId: task.botId, agentId: input.agentId, deviceRepoId: input.deviceRepoId })
  if (!target) eveFactoryRefusal('eveFactoryComputeUnavailable')
  const { rows: [repo] } = await tx.query<{ repoPath: string; remoteUrl: string | null; baseBranch: string | null }>(
    `SELECT "repoPath","remoteUrl","baseBranch" FROM device_repos WHERE id=$1 AND "userId"=$2 AND "deviceId"=$3 FOR SHARE`,
    [input.deviceRepoId, userId, target.deviceId])
  if (!repo?.remoteUrl || !repo.repoPath.startsWith('v2/github.com/')) eveFactoryRefusal('eveFactoryComputeUnavailable')
  // Project/Repository policy admission is the same as a native cloud run:
  // restricted workspaces, project bindings and Environment eligibility are
  // frozen into the snapshot the task-machine grant later demands.
  const projectExecution = await (await import('../../project-resources/store')).withProjectExecution(
    { userId, workspaceId: actor.workspaceId, issueId: task.issueId, repositoryKey: repo.repoPath, baseBranch: repo.baseBranch, runtime: 'cloud', harness: target.harness },
    snapshot => Promise.resolve(snapshot),
  )

  const plan: EveFactoryPlan = {
    version: EVE_FACTORY_CONTRACT_VERSION,
    role,
    provider: descriptor.id,
    model: model ?? descriptor.defaultModel,
    effort,
    sessionOpens: 0,
    sessionId: null,
    deliveryId: null,
    capabilityLimitations,
    releasedWhileWaiting: true,
  }
  await recordEveFactoryRoute(tx, { taskId: task.id, attemptId: context.attemptId }, descriptor.id)
  await tx.query(`UPDATE factory_attempts SET output = output || $2::jsonb WHERE id=$1`,
    [context.attemptId, JSON.stringify({ eveFactory: plan })])

  // The implementer's task branch is admitted through the ordinary
  // publication machinery before the prompt names it: push goes through the
  // same run_publications/GitHub path, never through Eve.
  const baseBranch = repo.baseBranch
  const push = role === 'implementer' ? await (await import('../../computer/cloud-push')).admitCloudPush(tx, {
    userId, issueId: task.issueId, agentId: input.agentId, deviceId: target.deviceId,
    deviceRepoId: input.deviceRepoId, baseBranch, workspaceId: actor.workspaceId, now: new Date(),
  }) : null
  if (role === 'implementer' && !push) eveFactoryRefusal('eveFactoryComputeUnavailable')
  const instructions = eveFactoryRoleInstructions(role, {
    repository: repo.remoteUrl,
    branch: push?.publication.branch ?? null,
    baseBranch: push?.publication.baseBranch ?? baseBranch,
  })
  const { prompt, taskLength } = runPromptParts(issue.title, tiptapToText(issue.content as never), instructions, input.note)
  const runId = eveRunId(userId, context.attemptId)
  const runBotId = task.botId
  const placeholder = {
    executor: EVE_FACTORY_EXECUTOR, role, provider: descriptor.id,
    eveFactory: { version: EVE_FACTORY_CONTRACT_VERSION, attemptId: context.attemptId },
    projectExecution,
    ...(push ? { repositoryAdmission: push.admission } : {}),
  }
  await tx.query(
    `INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,kind,"baseBranch",prompt,"botId","agentDefinition","promptTaskStart","promptTaskLength","workspaceId",origin,"originRef")
     VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11,0,$12,$13,'factory',NULL)
     ON CONFLICT (id) DO NOTHING`,
    [runId, userId, task.issueId, input.agentId, target.deviceId, input.deviceRepoId, eveRoleKind[role],
      push?.publication.baseBranch ?? baseBranch ?? 'main', prompt, runBotId, JSON.stringify(placeholder), taskLength, actor.workspaceId],
  )
  if (push) await tx.query(
    `INSERT INTO run_publications ("runId","userId","issueId","scopeVersion","issueTitle","remoteUrl","remoteKey",identifier,branch,"baseBranch","pushApproved")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true) ON CONFLICT ("runId") DO NOTHING`,
    [runId, push.publication.userId, push.publication.issueId, push.publication.scopeVersion, push.publication.issueTitle,
      push.publication.remoteUrl, push.publication.remoteKey, push.publication.identifier, push.publication.branch, push.publication.baseBranch],
  )
  await tx.query('INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)',
    [runId, runBotId, actor.workspaceId, userId])
  await tx.query(
    `INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","snapshotId","operationId",state,"issueId","deviceId","repoId")
     VALUES ($1,$2,$3,$4,$5,$6,'starting',$7,$8,$9) ON CONFLICT DO NOTHING`,
    [runId, actor.workspaceId, userId, runBotId, hostedSnapshot, randomUUID(), task.issueId, target.deviceId, input.deviceRepoId],
  )
  return { runId }
}

/**
 * Freeze adapter: writes the full worker definition for the role run —
 * the provider/model receipt, the sponsored task-machine placement and the
 * execution identity. `harness` stays 'eve_factory' so no native claim path
 * can pick the run up; `modelSource` records that the provider/model pair
 * went through Mikka's hosted model metering, not a subscription or API key.
 */
export const eveFactoryFreeze: FactoryDispatchAdapters['freeze'] = async (tx, task, runId) => {
  const { rows: [row] } = await tx.query<{
    id: string; userId: string; deviceId: string; prompt: string; agentDefinition: Record<string, unknown> | null
    repoPath: string | null; workspaceId: string; attemptOutput: Record<string, unknown>
  }>(
    `SELECT r.id,r."userId",r."deviceId",r.prompt,r."agentDefinition",repo."repoPath",b."workspaceId",a.output AS "attemptOutput"
     FROM agent_runs r JOIN agents a0 ON a0.id=r."agentId" AND a0."userId"=r."userId"
     JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId" AND repo."deviceId"=r."deviceId"
     JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
     JOIN factory_attempts a ON a.id=$3 AND a."taskId"=$4
     WHERE r.id=$1 AND r."userId"=$2 FOR UPDATE OF r FOR SHARE OF a0,repo`,
    [runId, task.userId, task.attemptId, task.id],
  )
  const plan = readEveFactoryPlan(row?.attemptOutput)
  if (!row || !plan || !isEveFactoryDefinition(row.agentDefinition)) throw new FactoryError('eveFactoryRouteMismatch')
  const { descriptor } = admitEveFactoryProvider({ provider: plan.provider, ...(plan.model ? { model: plan.model } : {}) })
  assertEveFactoryRoleCapability(descriptor, plan.role as EveFactoryDispatchRole)
  const taskMachine = {
    provider: 'cloudflare' as const, payer: 'mikka' as const, ownerId: task.userId, workspaceId: row.workspaceId,
    taskId: task.issueId, botId: task.botId!, repositoryKey: row.repoPath!, requestEventId: task.sourceEventId,
  }
  const frozen = freezeWorkerDefinition({
    harness: 'claude_code', // replaced below; 'eve_factory' is outside the Harness union by design.
    instructions: '', prompt: row.prompt, parent: null, executionId: null,
    model: plan.model, readOnly: plan.role !== 'implementer',
  })
  const definition: WorkerDefinitionSnapshot & Record<string, unknown> = {
    ...frozen,
    harness: EVE_FACTORY_EXECUTOR as WorkerDefinitionSnapshot['harness'],
    // Mikka model-gateway metering, like `credits`: the role's provider model
    // never carries a user subscription or API key.
    modelSource: 'credits',
    executor: EVE_FACTORY_EXECUTOR,
    provider: descriptor.id,
    role: plan.role,
    eveFactoryVersion: EVE_FACTORY_CONTRACT_VERSION,
    taskMachine,
    ...(row.agentDefinition?.projectExecution ? { projectExecution: row.agentDefinition.projectExecution as WorkerDefinitionSnapshot['projectExecution'] } : {}),
    ...(row.agentDefinition?.repositoryAdmission ? { repositoryAdmission: row.agentDefinition.repositoryAdmission as WorkerDefinitionSnapshot['repositoryAdmission'] } : {}),
  }
  definition.definitionDigest = workerDefinitionDigest({
    harness: EVE_FACTORY_EXECUTOR, instructions: frozen.instructions, model: plan.model,
    readOnly: plan.role !== 'implementer', taskMachine,
    ...(row.agentDefinition?.projectExecution ? { projectExecution: row.agentDefinition.projectExecution } : {}),
  })
  definition.executionIdentity = await freezeExecutionIdentity(tx, {
    userId: task.userId, botId: task.botId, deviceId: row.deviceId, agentDefinition: definition,
  }, undefined, row.workspaceId)
  await tx.query(`UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1`, [runId, JSON.stringify(definition)])
}

/** Eve stage configuration shares the Factory's own stage adapters: plan-kind
 * spec runs, the repair brief and the existing independent check. */
export const eveFactoryDispatchAdapters: FactoryDispatchAdapters = {
  configure: {
    spec: defaultFactoryDispatchAdapters.configure.spec,
    execute: defaultFactoryDispatchAdapters.configure.execute,
    review: defaultFactoryDispatchAdapters.configure.review,
    verify: defaultFactoryDispatchAdapters.configure.verify,
  },
  freeze: eveFactoryFreeze,
}

/**
 * Explicit provider intake: a task that selected a third-party provider is
 * routed `cloud.eve_factory`. Provider+model is the caller's only choice;
 * placement is fixed cloud, harness is fixed null, and `selection` records
 * the admitted identity on the task route for every later stage.
 */
export async function queueFactoryEveRun(pool: Pool, userId: string, input: {
  issueId: string; botId: string; agentId: string; deviceRepoId: string; note?: string
  key?: string; sourceEventId?: string; previousRunId?: string; needsSpec?: boolean; ownerRequested?: boolean
  provider: string; model?: string; effort?: string
}) {
  const { descriptor, model, effort } = admitEveFactoryProvider({
    provider: input.provider,
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  })
  if (!descriptor.workspaceWrite) eveFactoryRefusal('eveFactoryComputeUnavailable')
  const { beginFactoryTransaction, commitFactoryTransaction, rollbackFactoryTransaction, forgetFactoryTransaction } = await import('../../factory/transaction')
  const tx = await pool.connect()
  try {
    await beginFactoryTransaction(tx)
    const result = await queueFactoryTask(pool, userId, {
      issueId: input.issueId, botId: input.botId, agentId: input.agentId, deviceRepoId: input.deviceRepoId,
      ...(input.note ? { note: input.note } : {}),
      ...(input.key ? { key: input.key } : {}),
      ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
      ...(input.previousRunId ? { previousRunId: input.previousRunId } : {}),
      ...(input.needsSpec ? { needsSpec: input.needsSpec } : {}),
      ...(input.ownerRequested ? { ownerRequested: input.ownerRequested } : {}),
      selection: { provider: descriptor.id, model, effort, executor: EVE_FACTORY_EXECUTOR },
      queue: queueEveFactoryStageRun,
    }, {
      client: tx,
      prepareAttempt: async (client, task) => {
        await client.query(`UPDATE factory_tasks SET route = COALESCE(route,'{}'::jsonb) || $2::jsonb WHERE id=$1`,
          [task.id, JSON.stringify({ eveFactory: { provider: descriptor.id, model, effort } })])
      },
    })
    await commitFactoryTransaction(tx)
    return { ...result, drive: () => driveEveFactoryStage(result.runId) }
  } catch (error) {
    await rollbackFactoryTransaction(tx)
    throw error
  } finally {
    forgetFactoryTransaction(tx)
    tx.release()
  }
}

/** An unopened role session leaves the queued run stranded; mark it failed so
 * the ordinary Factory failed-run path (repair/revision, bounded by
 * checkFactoryRepairBudget) owns the next decision rather than a silent hang. */
export async function failEveFactoryStage(runId: string, code: string) {
  const { pool } = await import('../../db')
  const { rowCount } = await pool.query(
    `UPDATE agent_runs SET status='failed',"stopReason"='error',"failureDetails"=$2,"finishedAt"=clock_timestamp(),"updatedAt"=now()
     WHERE id=$1 AND status='queued'`,
    [runId, JSON.stringify({ code })],
  )
  return rowCount
}

/**
 * Stage driver: opens the role's Eve session through the factory-attempts
 * channel. Called after the dispatch commit so a failed open never holds the
 * task lock — the attempt keeps its queued run and a retry re-enters here.
 */
export async function driveEveFactoryStage(runId: string) {
  const { pool } = await import('../../db')
  const { rows: [run] } = await pool.query<{ userId: string; botId: string | null; workspaceId: string }>(
    `SELECT r."userId",b."botId",b."workspaceId" FROM agent_runs r
     JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId" WHERE r.id=$1`,
    [runId])
  if (!run?.botId || !run.workspaceId) eveFactoryRefusal('eveFactoryRouteMismatch')
  const scope: EveScope = { ownerId: run.userId, botId: run.botId, workspaceId: run.workspaceId, surface: 'web' }
  const target = new URL(eveInternalOrigin())
  target.pathname = target.pathname.replace(/\/$/, '') + '/eve/v1/mikka/factory-attempts'
  const response = await fetch(target, {
    method: 'POST', redirect: 'error',
    headers: { ...internalEveHeaders(scope), 'content-type': 'application/json' },
    body: JSON.stringify({ runId }), signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: string } | null
    throw new FactoryError(typeof body?.code === 'string' ? body.code : 'eveFactorySessionUnavailable')
  }
  return await response.json() as { ok: true; sessionId: string; deliveryId: string | null }
}

/**
 * Settlement branch for `surface='factory'` sessions: the role turn's
 * structured result becomes the bound run's completion through the ordinary
 * run/factory reconciliation — the same report shape, the same gates, no Eve
 * authority of its own.
 */
export async function eveFactorySettleTurn(scope: EveScope, input: EveTurnSettlement): Promise<boolean> {
  const { pool } = await import('../../db')
  const { rows: [bound] } = await pool.query<{
    runId: string; taskId: string; attemptId: string; stage: FactoryStage; candidateRunId: string | null
    output: Record<string, unknown>; host: Record<string, unknown> | null; check: Record<string, unknown> | null
    publicationBranch: string | null
  }>(
    `SELECT a."runId",a."taskId",a.id AS "attemptId",t.stage,c."runId" AS "candidateRunId",a.output,
      a.output->'eveFactoryHost' AS "host",a.output->'check' AS "check",p.branch AS "publicationBranch"
     FROM eve_sessions s JOIN factory_attempts a ON a."sessionId"=s.session_id
     JOIN factory_tasks t ON t.id=a."taskId"
     LEFT JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
     LEFT JOIN run_publications p ON p."runId"=a."runId"
     WHERE s.session_id=$1 AND s.owner_id=$2 AND s.bot_id=$3::uuid AND s.surface='factory'`,
    [input.sessionId, scope.ownerId, scope.botId],
  )
  if (!bound) return false
  const plan = readEveFactoryPlan(bound.output)
  if (!bound.runId || !plan) throw new FactoryError('eveFactoryRouteMismatch')
  // Self-review is a refusal, not a finding: the reviewer run can never be the
  // run that produced the candidate under review.
  if (plan.role === 'reviewer' && bound.candidateRunId === bound.runId) eveFactoryRefusal('eveFactoryReviewerUnavailable')
  const result: EveFactoryRoleResult | null = eveFactoryResultFromMessages(input.messages)
  const failed = input.outcome !== 'completed' || !result
  const hostRow = bound.host
  const host = hostRow ? {
    headSha: typeof hostRow.headSha === 'string' ? hostRow.headSha : null,
    branchRefSha: typeof hostRow.branchRefSha === 'string' ? hostRow.branchRefSha : null,
    filesChanged: Array.isArray(hostRow.filesChanged) ? hostRow.filesChanged.filter((f): f is string => typeof f === 'string').slice(0, 200) : [],
    verify: hostRow.verify && typeof hostRow.verify === 'object' ? hostRow.verify as EveFactoryReportHost['verify'] : { status: 'not_run' as const },
    check: bound.check ? {
      sha: typeof bound.check.sha === 'string' ? bound.check.sha : null,
      command: typeof bound.check.command === 'string' ? bound.check.command : null,
      reportOnly: bound.check.reportOnly === true,
    } : null,
    publicationBranch: bound.publicationBranch,
  } : undefined
  const report = result ? eveFactoryReportFor(plan.role as EveFactoryDispatchRole, result, host) : undefined
  const stopReason = input.outcome === 'cancelled' ? 'cancelled' : failed ? 'error' : 'submitted'
  await pool.query(
    `UPDATE factory_attempts SET output = output || $2::jsonb WHERE id=$1`,
    [bound.attemptId, JSON.stringify({ eveFactory: { ...plan, result: { outcome: input.outcome, turnId: input.turnId, ...(report ? { report } : {}) } } })],
  )
  const { persistRunCompletion } = await import('../../run-publications')
  await persistRunCompletion(scope.ownerId, bound.runId, { stopReason, ...(report ? { report } : {}) })
  return true
}
