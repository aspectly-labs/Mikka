import { z } from 'zod'
import type { PoolClient } from 'pg'
import { FactoryError } from './contract'

/**
 * #3081: the versioned, explicit place × harness execution-route contract.
 *
 * Every Factory-bound run resolves to exactly one route at queue time; the
 * resolved route is frozen on the attempt as its audit receipt. There is no
 * `auto` fallback (#537): an unmatched place/harness/provider combination is
 * refused, never substituted with another harness, place or provider.
 *
 * This module is the route contract and resolver only. Place, harness, model,
 * credential and repository authorization stay with the existing queue
 * admission checks (device membership, cloud runtimes, run-model selection);
 * this resolver verifies the admitted result belongs to the declared matrix
 * instead of re-deciding it.
 */

export const EXECUTION_ROUTE_VERSION = 1 as const

/**
 * Where a stage run executes. `device` is the person's own machine
 * (`devices.kind='local'`, the registered daemon); `cloud` is Mikka's
 * Cloudflare task machine (`devices.kind='cloud'`).
 */
export type ExecutionPlace = 'cloud' | 'device'

/**
 * The executor that runs the run on a place: the native CLI inside the CF
 * task machine, the local daemon's native CLI, or the Eve Software Factory
 * adapter for a third-party provider.
 */
export type ExecutorKind = 'cf_task_machine' | 'local_daemon' | 'eve_factory'

/** Native harnesses a person can select for a task run (lib/task-create-command.ts). */
export const ROUTE_HARNESSES = ['claude_code', 'codex'] as const
export type RouteHarness = (typeof ROUTE_HARNESSES)[number]

/**
 * Harnesses that predate the #3081 contract and still execute on the person's
 * own daemon. They resolve so existing tasks stay valid, but they are not
 * declared routes and are never admitted on cloud.
 */
export const LEGACY_DEVICE_HARNESSES = ['cursor', 'mock'] as const
export type LegacyDeviceHarness = (typeof LEGACY_DEVICE_HARNESSES)[number]
export type ExecutionRouteHarness = RouteHarness | LegacyDeviceHarness

export interface ExecutionRoute {
  version: typeof EXECUTION_ROUTE_VERSION
  /** Stable id: `cloud.claude_code`, `cloud.codex`, `device.claude_code`,
   * `device.codex`, `cloud.eve_factory`, or `device.<legacy harness>`. */
  routeId: string
  place: ExecutionPlace
  executor: ExecutorKind
  /** The native CLI harness driving the run; null only on the Eve provider route. */
  harness: ExecutionRouteHarness | null
  /** The third-party provider on the Eve factory route; null elsewhere. */
  provider: string | null
  /** True for the declared #3081 matrix; false for a legacy harness continuation. */
  declared: boolean
}

interface RouteRow {
  routeId: string
  place: ExecutionPlace
  executor: ExecutorKind
  harness: RouteHarness | null
}

/**
 * The user-specified execution matrix (issue #3081, epic #3076). Five declared
 * routes; ordinary Bot chat keeps its existing Eve Agent Runtime and is not a
 * route here. `cloud.eve_factory` is the versioned third-party marker: its
 * adapter (#3082) binds this route to a run inside the same FactoryTask
 * lifecycle — no parallel `eveTasks` table.
 */
export const EXECUTION_ROUTES = [
  { routeId: 'cloud.claude_code', place: 'cloud', executor: 'cf_task_machine', harness: 'claude_code' },
  { routeId: 'cloud.codex', place: 'cloud', executor: 'cf_task_machine', harness: 'codex' },
  { routeId: 'device.claude_code', place: 'device', executor: 'local_daemon', harness: 'claude_code' },
  { routeId: 'device.codex', place: 'device', executor: 'local_daemon', harness: 'codex' },
  { routeId: 'cloud.eve_factory', place: 'cloud', executor: 'eve_factory', harness: null },
] as const satisfies readonly RouteRow[]

/** A provider id a person or host adapter may select on the Eve factory
 * route: the model provider name, never a credential value. */
export const routeProviderSchema = z.string().trim().min(1).max(128)
  .regex(/^[a-z0-9][a-z0-9_.:/-]*$/i)

/** An explicit selection a host adapter can ask the resolver to admit. */
export const executionRouteSelectionSchema = z.strictObject({
  place: z.enum(['cloud', 'device']),
  harness: z.enum(ROUTE_HARNESSES).optional(),
  provider: routeProviderSchema.optional(),
}).refine(value => Boolean(value.harness) !== Boolean(value.provider), {
  message: 'exactly one of harness or provider',
})
export type ExecutionRouteSelection = z.infer<typeof executionRouteSelectionSchema>

/** The frozen receipt shape persisted on `factory_attempts.output.executionRoute`. */
export const executionRouteSchema = z.strictObject({
  version: z.literal(EXECUTION_ROUTE_VERSION),
  routeId: z.string().trim().min(1).max(64),
  place: z.enum(['cloud', 'device']),
  executor: z.enum(['cf_task_machine', 'local_daemon', 'eve_factory']),
  harness: z.enum([...ROUTE_HARNESSES, ...LEGACY_DEVICE_HARNESSES] as [ExecutionRouteHarness, ...ExecutionRouteHarness[]]).nullable(),
  provider: routeProviderSchema.nullable(),
  declared: z.boolean(),
})

const UNAVAILABLE = 'factoryRouteUnavailable'

/**
 * Resolve an explicit place × harness/provider selection to its one route.
 * `harness` and `provider` are mutually exclusive; a provider executes only
 * through the Eve factory adapter on cloud. Unmatched combinations throw
 * `factoryRouteUnavailable` — an explicit refusal, never a fallback.
 */
export function resolveExecutionRoute(selection: {
  place: ExecutionPlace
  harness?: string | null
  provider?: string | null
}): ExecutionRoute {
  const provider = typeof selection.provider === 'string' ? selection.provider.trim() : ''
  const harness = typeof selection.harness === 'string' ? selection.harness.trim() : ''
  if (provider && harness) throw new FactoryError(UNAVAILABLE)
  if (provider) {
    const parsed = routeProviderSchema.safeParse(provider)
    if (selection.place !== 'cloud' || !parsed.success) throw new FactoryError(UNAVAILABLE)
    return { version: EXECUTION_ROUTE_VERSION, routeId: 'cloud.eve_factory', place: 'cloud', executor: 'eve_factory', harness: null, provider: parsed.data, declared: true }
  }
  if (!harness) throw new FactoryError(UNAVAILABLE)
  const declared = EXECUTION_ROUTES.find(route => route.place === selection.place && route.harness === harness)
  if (declared) {
    return { version: EXECUTION_ROUTE_VERSION, routeId: declared.routeId, place: declared.place, executor: declared.executor, harness: harness as RouteHarness, provider: null, declared: true }
  }
  if (selection.place === 'device' && (LEGACY_DEVICE_HARNESSES as readonly string[]).includes(harness)) {
    return { version: EXECUTION_ROUTE_VERSION, routeId: `device.${harness}`, place: 'device', executor: 'local_daemon', harness: harness as LegacyDeviceHarness, provider: null, declared: false }
  }
  throw new FactoryError(UNAVAILABLE)
}

/** `devices.kind` → route place. Any other value resolves no place. */
export function deviceKindToPlace(kind: string | null | undefined): ExecutionPlace | null {
  return kind === 'cloud' ? 'cloud' : kind === 'local' ? 'device' : null
}

/**
 * The route a persisted run actually takes, derived from its own device row
 * and frozen harness. The run's stored rows are the authority: a tampered or
 * inconsistent combination is refused, not reinterpreted.
 */
export function executionRouteForRun(run: { deviceKind?: string | null; harness?: string | null; provider?: string | null }): ExecutionRoute {
  const place = deviceKindToPlace(run.deviceKind)
  if (!place) throw new FactoryError(UNAVAILABLE)
  // #3082: a frozen Eve Factory definition carries the admitted third-party
  // provider in place of a native harness; the resolver refuses the
  // combination rather than substituting a native route.
  return resolveExecutionRoute({ place, harness: run.harness, provider: run.provider })
}

/**
 * Persist the resolved route on the attempt inside the dispatch transaction.
 * The receipt is the audit/UI record of which route this stage attempt took;
 * attempts written before the contract derive their route on the read path.
 */
export async function recordExecutionRoute(
  tx: Pick<PoolClient, 'query'>,
  input: { taskId: string; attemptId: string },
  route: ExecutionRoute,
) {
  await tx.query(`UPDATE factory_attempts SET output = output || $3::jsonb WHERE id=$1 AND "taskId"=$2`,
    [input.attemptId, input.taskId, JSON.stringify({ executionRoute: executionRouteSchema.parse(route) })])
}
