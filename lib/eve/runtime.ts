import type { DynamicModelContext } from 'eve'
import { defineState } from 'eve/context'
import {evaluationForSession,evaluationModel} from './evaluation-runtime'
import { HostedWorkflowModel } from '../abuse/workflow-model'
import { SubscriptionWorkflowModel } from '../subscription-workflow-model'
import { scopeFromAuth } from './scope'
import { streamingModel } from './streaming-model'
import { withModelEffort } from '../model-effort'
import { MODEL_ROUTING_EFFORTS, type ModelRoutingEffort } from '../model-routing'
import type { DefinitionSnapshot } from '../agent-kit/definition'
import type { HostedRuntimeSnapshot } from '../subscription-model-snapshot'
import type { ScheduledRead } from '../schedules/contract'

// The turn.started hook selects the person's model and Bot capabilities.
// Eve persists these business choices before evaluating the turn's definitions.
export const turnModel = defineState<HostedRuntimeSnapshot | null>('mikka.model', () => null)
export const turnPolicy = defineState<Pick<DefinitionSnapshot, 'definition' | 'effectiveTools' | 'personalPlugins'> | null>('mikka.policy', () => null)
export const turnRequest = defineState<{ sourceEventId?: string; scheduledRead: ScheduledRead | null; startIndex?: number }>('mikka.request', () => ({ scheduledRead: null }))

/** #3082: a Factory role session selects its model from the frozen role plan
 * — hosted model-gateway metering only, never the person's subscription or
 * API key — and skips Bot-runtime/policy resolution entirely. Called from the
 * turn.started hook. */
export function eveFactoryTurnStarted(factory: { model: string; effort: string | null }, startIndex?: number) {
  const effort = factory.effort && (MODEL_ROUTING_EFFORTS as readonly string[]).includes(factory.effort)
    ? factory.effort as ModelRoutingEffort : undefined
  turnModel.update(() => ({ harness: 'ai_sdk', model: factory.model, ...(effort ? { effort } : {}) }))
  turnRequest.update(() => ({ scheduledRead: null, ...(startIndex !== undefined ? { startIndex } : {}) }))
}

export async function modelForSession(ctx: DynamicModelContext) {
  const evaluation=await evaluationForSession(ctx)
  if(evaluation)return evaluationModel(evaluation)
  const scope = scopeFromAuth(ctx.session.auth.current)
  const runtime = turnModel.get()
  if (!runtime || runtime.harness !== 'ai_sdk' || !runtime.model) throw new Error('subscription_model_unavailable')
  if (!runtime.modelSelection) return withModelEffort(new HostedWorkflowModel(scope.ownerId, scope.botId, runtime.model), runtime.effort)
  const requestPolicy = ctx.session.parent || turnRequest.get().scheduledRead ? undefined : { codexServiceTier: 'priority' as const }
  return withModelEffort(streamingModel(new SubscriptionWorkflowModel(runtime.modelSelection, requestPolicy)), runtime.effort)
}

export async function instructionsForSession(ctx: DynamicModelContext) {
  const evaluation=await evaluationForSession(ctx)
  if(evaluation)return evaluation.instructions
  const scope = scopeFromAuth(ctx.session.auth.current)
  // #3082: a Factory role session's instructions come from the persisted run
  // and attempt — the admitted repository, task branch and fixed candidate —
  // never the person's product principal or chat policy.
  const { eveFactorySessionAuth, eveFactoryRoleInstructions } = await import('./factory/session')
  const factory = eveFactorySessionAuth(ctx.session.auth.current)
  if (factory) {
    const { pool } = await import('../db')
    const { rows: [run] } = await pool.query<{
      remoteUrl: string | null; branch: string | null; baseBranch: string | null; checkSha: string | null
    }>(
      `SELECT repo."remoteUrl",p.branch,p."baseBranch",a.output#>>'{check,sha}' AS "checkSha"
       FROM agent_runs r JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId" AND repo."deviceId"=r."deviceId"
       LEFT JOIN run_publications p ON p."runId"=r.id
       LEFT JOIN factory_attempts a ON a.id=$2 AND a."taskId"=$3
       WHERE r.id=$1 AND r."userId"=$4`,
      [factory.runId, factory.attemptId, factory.taskId, scope.ownerId],
    )
    return eveFactoryRoleInstructions(factory.role, {
      repository: run?.remoteUrl ?? null, branch: run?.branch ?? null,
      baseBranch: run?.baseBranch ?? null, executionSha: run?.checkSha ?? null,
    })
  }
  const { scheduledRead } = turnRequest.get()
  if (scheduledRead) return `This is an authorized scheduled read-only task. Use only the provided read tools. Do not request approval, create schedules or perform writes. Return the result for the original chat.\n${scheduledRead.prompt}`
  // Slack gets product policy but never private web history, memory or profile.
  if (scope.surface === 'slack') {
    const { COORDINATOR_INSTRUCTIONS } = await import('../coordinator/instructions')
    return COORDINATOR_INSTRUCTIONS + '\nUse only this Slack conversation. Do not access private web chat history or memories. Reply in the same thread; call no_reply when no useful response is needed.'
  }
  const { asProductPrincipal } = await import('./product-definitions')
  return asProductPrincipal(scope, async () => {
    const { composeEveInstructions } = await import('../coordinator/product-instructions')
    return composeEveInstructions(scope.ownerId, scope.botId, undefined, { sessionId: ctx.session.id, turnId: ctx.turn!.id }, turnPolicy.get() ?? undefined)
  })
}
