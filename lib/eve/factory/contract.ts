import { z } from 'zod'
import type { PoolClient } from 'pg'
import { FactoryError, type FactoryStage } from '../../factory/contract'

/**
 * #3082: the Eve Software Factory adapter contract for the third-party
 * provider route (`cloud.eve_factory`, #3081). Mikka's FactoryTask 8-stage
 * state machine stays the only lifecycle authority; this module is the
 * role/attempt binding only — no second task store, scheduler or Foreman
 * service.
 *
 * The four workstation roles are adapted from the MIT-licensed
 * vercel-labs/eve-software-factory-template
 * (https://github.com/vercel-labs/eve-software-factory-template):
 * Classifier → clarify/routing, Analyst → spec, Implementer → execute,
 * Reviewer → review. Mikka's verify/approval/publish/monitor stages and its
 * independent-check, CI and merge gates are unchanged and stay host-owned —
 * the template never merges, publishes or bypasses approval.
 */

export const EVE_FACTORY_CONTRACT_VERSION = 1 as const

/** Template role ids. `classifier` maps to the Factory's own clarify/routing
 * checks (no model turn is dispatched for clarify); the other three roles are
 * real Eve sessions driven by the adapter. */
export const EVE_FACTORY_ROLES = ['classifier', 'analyst', 'implementer', 'reviewer'] as const
export type EveFactoryRole = (typeof EVE_FACTORY_ROLES)[number]

/** Stage → role. Stages absent from this map are host-owned and never run an
 * Eve role (verify is Mikka's independent check; approval/publish/monitor are
 * the existing gates). */
export function eveFactoryRoleForStage(stage: FactoryStage): EveFactoryRole | null {
  switch (stage) {
    case 'clarify': return 'classifier'
    case 'spec': return 'analyst'
    case 'execute': return 'implementer'
    case 'review': return 'reviewer'
    default: return null
  }
}

/** A role session is only ever started for a stage the Factory actually
 * dispatches. Clarify waits on the existing questions machinery. */
export const EVE_FACTORY_DISPATCH_ROLES = ['analyst', 'implementer', 'reviewer'] as const
export type EveFactoryDispatchRole = (typeof EVE_FACTORY_DISPATCH_ROLES)[number]

/** Bounded role work: a stage attempt may open at most this many Eve sessions
 * (initial open plus adapter retries). The Factory's own repair budget
 * additionally bounds task-level revision loops. */
export const EVE_FACTORY_MAX_SESSION_OPENS = 3 as const
/** A claimed Eve role run's lease; expiry reclaims the run for recovery. */
export const EVE_FACTORY_SESSION_LEASE_MS = 15 * 60 * 1000

export const EVE_FACTORY_REFUSALS = [
  'eveFactoryProviderUnavailable',
  'eveFactoryReviewerUnavailable',
  'eveFactoryRouteMismatch',
  'eveFactoryRoleBudgetExceeded',
  'eveFactorySessionUnavailable',
  'eveFactoryComputeUnavailable',
] as const
export type EveFactoryRefusal = (typeof EVE_FACTORY_REFUSALS)[number]

export function eveFactoryRefusal(code: EveFactoryRefusal): never {
  throw new FactoryError(code)
}

/**
 * The frozen role plan persisted on `factory_attempts.output.eveFactory` —
 * standard attempt evidence written inside the dispatch transaction. Every
 * field is host-computed at admission; a provider/model input can narrow
 * `model`/`effort` only through the registered provider descriptor.
 */
export const eveFactoryPlanSchema = z.strictObject({
  version: z.literal(EVE_FACTORY_CONTRACT_VERSION),
  role: z.enum(EVE_FACTORY_ROLES),
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(500),
  effort: z.string().min(1).max(64).nullable(),
  /** How many times a session was opened for this attempt; bounded by
   * EVE_FACTORY_MAX_SESSION_OPENS. */
  sessionOpens: z.number().int().min(0).max(EVE_FACTORY_MAX_SESSION_OPENS).default(0),
  /** Durable Eve identities once the role session exists. */
  sessionId: z.string().min(1).max(1000).nullable(),
  deliveryId: z.string().min(1).max(1000).nullable(),
  /** Explicit provider capability limits reported, never hidden: e.g.
   * ['independent_vendor_reviewer'] when a provider cannot run an isolated
   * reviewer principal. A limitation is evidence, never a silent fallback. */
  capabilityLimitations: z.array(z.string().min(1).max(200)).max(20).default([]),
  /** True while this route holds no container between stages: role compute is
   * opened only for the active turn and parked at turn end. */
  releasedWhileWaiting: z.literal(true),
  /** The role's structured result once its turn settles; written by the
   * settlement path, not by dispatch. */
  result: z.record(z.string(), z.unknown()).optional(),
})
export type EveFactoryPlan = z.infer<typeof eveFactoryPlanSchema>

/** The #3081 execution-route receipt restricted to the Eve route. Written
 * here until lib/factory/execution-route.ts lands: identical bytes, one
 * contract, two writers (#3081 dispatch hook writes native routes). */
export const eveFactoryRouteSchema = z.strictObject({
  version: z.literal(1),
  routeId: z.literal('cloud.eve_factory'),
  place: z.literal('cloud'),
  executor: z.literal('eve_factory'),
  harness: z.null(),
  provider: z.string().min(1).max(128),
  declared: z.literal(true),
})
export type EveFactoryRoute = z.infer<typeof eveFactoryRouteSchema>

export function eveFactoryRouteReceipt(provider: string): EveFactoryRoute {
  return { version: 1, routeId: 'cloud.eve_factory', place: 'cloud', executor: 'eve_factory', harness: null, provider, declared: true }
}

/** The attempt's recorded route receipt; null when absent or not the Eve
 * route. Never throws: evidence reads stay honest about missing data. */
export function readEveFactoryRoute(output: unknown): EveFactoryRoute | null {
  const parsed = output && typeof output === 'object'
    ? eveFactoryRouteSchema.safeParse((output as Record<string, unknown>).executionRoute)
    : { success: false as const }
  return parsed.success ? parsed.data : null
}

export function readEveFactoryPlan(output: unknown): EveFactoryPlan | null {
  const parsed = output && typeof output === 'object'
    ? eveFactoryPlanSchema.safeParse((output as Record<string, unknown>).eveFactory)
    : { success: false as const }
  return parsed.success ? parsed.data : null
}

/** Write the Eve route receipt on the attempt inside the dispatch
 * transaction — same shape as #3081's recordExecutionRoute. */
export async function recordEveFactoryRoute(
  tx: Pick<PoolClient, 'query'>,
  input: { taskId: string; attemptId: string },
  provider: string,
) {
  await tx.query(`UPDATE factory_attempts SET output = output || $3::jsonb WHERE id=$1 AND "taskId"=$2`,
    [input.attemptId, input.taskId, JSON.stringify({ executionRoute: eveFactoryRouteReceipt(provider) })])
}

/** Whether a frozen run belongs to this adapter (its definition was frozen
 * by the Eve queue, not by a native-harness queue). */
export function isEveFactoryDefinition(definition: unknown): boolean {
  return Boolean(definition && typeof definition === 'object'
    && (definition as Record<string, unknown>).executor === 'eve_factory'
    && typeof (definition as Record<string, unknown>).provider === 'string')
}

/** The frozen agent definition marker. `harness` stays 'eve_factory' so no
 * native worker claim path (claude_code/codex only) can pick the run up, and
 * the persisted executor/provider carry the real route. */
export const EVE_FACTORY_EXECUTOR = 'eve_factory' as const
export type EveFactoryWorkerFields = {
  executor: typeof EVE_FACTORY_EXECUTOR
  provider: string
  role: EveFactoryRole
  eveFactoryVersion: typeof EVE_FACTORY_CONTRACT_VERSION
}
