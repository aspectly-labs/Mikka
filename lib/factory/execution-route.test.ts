import assert from 'node:assert/strict'
import test from 'node:test'
import { FactoryError } from './contract'
import {
  EXECUTION_ROUTE_VERSION,
  EXECUTION_ROUTES,
  deviceKindToPlace,
  executionRouteForRun,
  executionRouteSchema,
  executionRouteSelectionSchema,
  resolveExecutionRoute,
} from './execution-route'

const unavailable = (fn: () => unknown) => assert.rejects(async () => fn(), (error: unknown) => error instanceof FactoryError && error.code === 'factoryRouteUnavailable')

test('#3081 declared matrix: the five user-specified routes resolve exactly', () => {
  assert.equal(EXECUTION_ROUTES.length, 5)
  assert.deepEqual(
    resolveExecutionRoute({ place: 'cloud', harness: 'claude_code' }),
    { version: EXECUTION_ROUTE_VERSION, routeId: 'cloud.claude_code', place: 'cloud', executor: 'cf_task_machine', harness: 'claude_code', provider: null, declared: true },
  )
  assert.deepEqual(
    resolveExecutionRoute({ place: 'cloud', harness: 'codex' }),
    { version: EXECUTION_ROUTE_VERSION, routeId: 'cloud.codex', place: 'cloud', executor: 'cf_task_machine', harness: 'codex', provider: null, declared: true },
  )
  assert.deepEqual(
    resolveExecutionRoute({ place: 'device', harness: 'claude_code' }),
    { version: EXECUTION_ROUTE_VERSION, routeId: 'device.claude_code', place: 'device', executor: 'local_daemon', harness: 'claude_code', provider: null, declared: true },
  )
  assert.deepEqual(
    resolveExecutionRoute({ place: 'device', harness: 'codex' }),
    { version: EXECUTION_ROUTE_VERSION, routeId: 'device.codex', place: 'device', executor: 'local_daemon', harness: 'codex', provider: null, declared: true },
  )
  assert.deepEqual(
    resolveExecutionRoute({ place: 'cloud', provider: 'custom/openai-compatible' }),
    { version: EXECUTION_ROUTE_VERSION, routeId: 'cloud.eve_factory', place: 'cloud', executor: 'eve_factory', harness: null, provider: 'custom/openai-compatible', declared: true },
  )
})

test('refusals: no silent fallback or substitution for unmatched selections', async () => {
  // A provider only executes through the Eve factory adapter on cloud.
  await unavailable(() => resolveExecutionRoute({ place: 'device', provider: 'custom' }))
  // The declared native harnesses and the provider selection never merge.
  await unavailable(() => resolveExecutionRoute({ place: 'cloud', harness: 'codex', provider: 'custom' }))
  // Neither missing nor unknown selections resolve.
  await unavailable(() => resolveExecutionRoute({ place: 'cloud' }))
  await unavailable(() => resolveExecutionRoute({ place: 'device' }))
  await unavailable(() => resolveExecutionRoute({ place: 'cloud', harness: 'cursor' }))
  await unavailable(() => resolveExecutionRoute({ place: 'cloud', harness: 'mock' }))
  await unavailable(() => resolveExecutionRoute({ place: 'device', harness: 'eve' }))
  await unavailable(() => resolveExecutionRoute({ place: 'cloud', harness: 'unknown-cli' }))
  // No implicit place exists either.
  await unavailable(() => resolveExecutionRoute({ place: 'edge' as never, harness: 'codex' }))
  // Provider names are validated, never trusted verbatim.
  await unavailable(() => resolveExecutionRoute({ place: 'cloud', provider: ' ' }))
  await unavailable(() => resolveExecutionRoute({ place: 'cloud', provider: 'bad provider!' }))
})

test('legacy device harnesses resolve so existing tasks stay valid, never on cloud', () => {
  for (const harness of ['cursor', 'mock'] as const) {
    const route = resolveExecutionRoute({ place: 'device', harness })
    assert.equal(route.executor, 'local_daemon')
    assert.equal(route.declared, false)
    assert.equal(route.routeId, `device.${harness}`)
    assert.equal(route.provider, null)
  }
})

test('executionRouteForRun derives the route from the persisted device and frozen harness', () => {
  assert.equal(deviceKindToPlace('local'), 'device')
  assert.equal(deviceKindToPlace('cloud'), 'cloud')
  assert.equal(deviceKindToPlace('serverless'), null)
  assert.equal(deviceKindToPlace(null), null)
  assert.equal(executionRouteForRun({ deviceKind: 'local', harness: 'codex' }).routeId, 'device.codex')
  assert.equal(executionRouteForRun({ deviceKind: 'cloud', harness: 'claude_code' }).routeId, 'cloud.claude_code')
  assert.equal(executionRouteForRun({ deviceKind: 'local', harness: 'cursor' }).declared, false)
})

test('executionRouteForRun refuses rows outside the matrix', async () => {
  await unavailable(() => executionRouteForRun({ deviceKind: null, harness: 'codex' }))
  await unavailable(() => executionRouteForRun({ deviceKind: 'local', harness: null }))
  await unavailable(() => executionRouteForRun({ deviceKind: 'cloud', harness: 'mock' }))
})

test('frozen receipt and explicit selection schemas round-trip only valid shapes', () => {
  for (const route of EXECUTION_ROUTES.map(row => resolveExecutionRoute(row.harness ? { place: row.place, harness: row.harness } : { place: row.place, provider: 'custom' })))
    assert.equal(executionRouteSchema.parse(route).routeId, route.routeId)
  assert.equal(executionRouteSelectionSchema.safeParse({ place: 'cloud', harness: 'codex' }).success, true)
  assert.equal(executionRouteSelectionSchema.safeParse({ place: 'cloud', provider: 'custom' }).success, true)
  assert.equal(executionRouteSelectionSchema.safeParse({ place: 'cloud', harness: 'codex', provider: 'custom' }).success, false)
  assert.equal(executionRouteSelectionSchema.safeParse({ place: 'cloud' }).success, false)
  assert.equal(executionRouteSchema.safeParse({ version: 2, routeId: 'x', place: 'cloud', executor: 'eve_factory', harness: null, provider: 'p', declared: true }).success, false)
  assert.equal(executionRouteSchema.safeParse({ version: 1, routeId: 'x', place: 'cloud', executor: 'unknown', harness: null, provider: 'p', declared: true }).success, false)
})
