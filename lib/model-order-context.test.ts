import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import type { OrderScope, OrderView } from './model-order'
import type { PoolDevice } from './model-order-plan'

type Trace = { sql: string; args: unknown[] }
type FixtureQuery = ReturnType<typeof fixture>
const unused = () => { throw new Error('unexpected external effect in order projection test') }
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('./execution-settings.ts', { ExecutionSettings: class {
  constructor(readonly query: FixtureQuery) {}
  async modelCandidates(scope: OrderScope) {
    assert.equal(scope.ownerId, this.query.scope.ownerId)
    assert.equal(scope.workspaceId, this.query.scope.workspaceId)
    if (this.query.failCandidates) throw this.query.failure
    return [{ ownerId: scope.ownerId, connectionId: this.query.connectionId, provider: 'claude', modelId: 'claude-haiku-5-5' }]
  }
} })
stub('./subscription-runtime.ts', { authorizeSubscriptionWorkspace: unused })
stub('./device-presence.ts', { deviceOnlineStates: unused })
stub('./cloud-template-models.ts', { cloudModelSupport: () => 'ready' })
stub('./execution-identity.ts', { executionMembersActive: unused, revalidateExecutionIdentity: unused, ExecutionIdentityError: class extends Error {} })
stub('./model-api-key-runs.ts', { stopRunsUsingApiKeys: unused })
stub('./secrets/crypto.ts', { openSecret: unused, sealSecret: unused, SecretsKeyMissingError: class extends Error {} })
stub('./live/panels.ts', { runChanged: unused })
stub('./live/lists.ts', { runListChanged: unused })
stub('./device-gateway-notify.ts', { runControlChanged: unused })
stub('./due-timer.ts', { armDueTimerAfterCommit: unused })

const policyWorkspaces = new Set<string>()
const resourcePolicySql = "select w.kind,l.\"organizationId\",p.\"modelCredentialSharing\",p.\"mcpSharing\",p.\"allowedModelProviders\" from mikka_workspaces w left join mikka_organization_workspaces l on l.\"workspaceId\"=w.id left join mikka_organization_resource_policies p on p.\"organizationId\"=l.\"organizationId\" where w.id=$1"
stub('./workspace-db.ts', {
  workspaceDb: { select: unused, transaction: unused },
  workspacePool: { query: async (sql: string, args: unknown[]) => {
    assert.equal(sql.replace(/\s+/g, ' ').trim(), resourcePolicySql)
    assert.ok(args.length === 1 && typeof args[0] === 'string' && policyWorkspaces.has(args[0]), 'resource policy is scoped to a Workspace created by this fixture')
    // The existing trace measures the injected APP executor; the separate
    // WS executor accepts only this exact current non-Org linkage read.
    return { rows: [{ kind: 'team', organizationId: null, modelCredentialSharing: null, mcpSharing: null, allowedModelProviders: null }], rowCount: 1 }
  } },
})

function fixture(allowed: boolean, ownerId = 'owner-a') {
  const scope = { ownerId, workspaceId: `workspace-${ownerId}` }
  policyWorkspaces.add(scope.workspaceId)
  const connectionId = `connection-${ownerId}`
  const key = { id: `key-${ownerId}`, ownerId, provider: 'deepseek', name: null, baseUrl: 'https://example.invalid', protocol: 'openai', last4: 'test', models: ['deepseek-flash'], modelsError: null, responsesApi: false }
  const quota = { vendor: 'claude_code', source: 'official', status: 'ok', plan: null, observedAt: new Date(Date.now() - 1000).toISOString(), windows: [{ kind: 'five_hour', used: 0.1, resetsAt: new Date(Date.now() + 3600000).toISOString() }] }
  const trace: Trace[] = []
  const failure = new Error('synthetic query refusal')
  const state = { scope, connectionId, trace, failure, paused: false, failCandidates: false, failStates: false, failCount: false,
    async query(sql: string, args: unknown[] = []) {
      trace.push({ sql, args: structuredClone(args) })
      if (sql.startsWith('SELECT subscriptions FROM workspace_personal_policies')) {
        assert.deepEqual(args, [scope.workspaceId]); return { rows: [{ subscriptions: allowed }] }
      }
      if (sql.startsWith('SELECT id::text AS id,"modelCatalog"')) return { rows: [{ id: connectionId, models: ['claude-haiku-5-5'] }] }
      if (sql.includes('WHERE ("ownerId"=$1 OR "workspaceId"=$2::uuid)')) {
        assert.equal(args[0], scope.ownerId); return { rows: [key] }
      }
      if (sql.includes('FROM model_order_settings')) return { rows: [{ location: 'local', customized: false, preferredHarness: 'claude_code', autoModelRouting: true }] }
      if (sql.startsWith('SELECT c.id::text AS id,c."ownerId"')) {
        if (state.failStates) throw failure
        return { rows: [{ id: connectionId, ownerId, state: 'connected', paused: state.paused, removed: false, provider: 'claude', epoch: '1', quota }] }
      }
      if (sql.startsWith('SELECT k.id::text AS id,k."modelsError"')) return { rows: [{ id: key.id, modelsError: null, provider: key.provider }] }
      if (sql.trimStart().startsWith('WITH requested AS')) return { rows: [] }
      if (sql.startsWith('SELECT id::text AS id FROM byos_connections WHERE')) {
        assert.deepEqual(args, [scope.ownerId])
        if (state.failCount) throw failure
        return { rows: [{ id: connectionId }] }
      }
      // Settings › Models adapts each candidate's level and speed controls (lib/model-capabilities-server.ts).
      if (sql.startsWith('SELECT id::text AS id, epoch::text AS epoch, "modelCatalog"->>\'revision\'')) return { rows: [] }
      throw new Error(`unexpected fixture query: ${sql}`)
    },
  }
  return state
}

const devices: PoolDevice[] = []
let orderView: typeof import('./model-order').orderView
let personalRunDefaults: typeof import('./model-order').personalRunDefaults
before(async () => {
  mock.method(globalThis, 'fetch', unused)
  ;({ orderView, personalRunDefaults } = await import('./model-order'))
})
const queryType = (query: FixtureQuery) => query as unknown as Parameters<typeof orderView>[0]
// The old implementation accepts and ignores a fourth JS argument, so this
// regression demonstrates the real redundant reads before the overload exists.
const context = (query: FixtureQuery) => Reflect.apply(orderView, undefined, [queryType(query), query.scope, async () => devices, 'context']) as Promise<Partial<OrderView>>
// Settings' per-model controls (capabilities) are not part of the prompt's projection.
const fields = (view: Partial<OrderView>) => ({ location: view.location, preferredHarness: view.preferredHarness, entries: view.entries, candidates: view.candidates?.map(({ capabilities: _controls, ...candidate }) => candidate), cloudReady: view.cloudReady, cloudModels: view.cloudModels })

for (const allowed of [false, true]) test(`prompt projection skips only unused credential counts when sharing is ${allowed}`, async t => {
  const fullQuery = fixture(allowed), promptQuery = fixture(allowed)
  const full = await orderView(queryType(fullQuery), fullQuery.scope, async () => devices)
  // The capability read serves Settings' controls only; the prompt never needs it.
  const capabilityRead = (row: { sql: string }) => row.sql.includes('"effortSupport"')
  assert.equal(fullQuery.trace.filter(capabilityRead).length, 1)
  assert.equal(promptQuery.trace.some(capabilityRead), false)
  fullQuery.trace.splice(0, fullQuery.trace.length, ...fullQuery.trace.filter(row => !capabilityRead(row)))
  const prompt = await context(promptQuery)
  // The full view counts connected subscriptions and the usable key rows (the
  // person's own and the workspace's, one read since decision 2026-11-27-1740).
  const saved = 2
  t.diagnostic(JSON.stringify({ kind: 'order_projection_query_budget', allowed, full: fullQuery.trace.length, context: promptQuery.trace.length, saved: fullQuery.trace.length - promptQuery.trace.length }))
  assert.equal(fullQuery.trace.length - promptQuery.trace.length, saved, 'prompt_unused_count_queries_remain')
  assert.deepEqual(prompt, fields(full), 'the prompt consumes the exact same model and credential-state projection')
  assert.equal(full.credentials, 2, 'the public settings response still counts both connected credentials')
  assert.equal(Object.hasOwn(prompt, 'credentials'), false, 'a missing count is never a fabricated zero')
  const countStart = fullQuery.trace.findIndex(row => row.sql.startsWith('SELECT id::text AS id FROM byos_connections WHERE'))
  assert.ok(countStart >= 0)
  assert.deepEqual(promptQuery.trace, [...fullQuery.trace.slice(0, countStart), ...fullQuery.trace.slice(countStart + saved)], 'all required queries and scoped arguments remain in their original order')
})

test('an unused count failure cannot discard prompt facts, while the full view still reports it', async () => {
  const query = fixture(true); query.failCount = true
  await assert.rejects(orderView(queryType(query), query.scope, async () => devices), error => error === query.failure)
  query.trace.length = 0
  const projected = await context(query)
  assert.ok(projected.entries?.length)
  assert.equal(query.trace.some(row => row.sql.startsWith('SELECT id::text AS id FROM byos_connections WHERE')), false)
})

for (const phase of ['failCandidates', 'failStates'] as const) test(`the prompt still rejects a required ${phase} check`, async () => {
  const query = fixture(true); query[phase] = true
  await assert.rejects(context(query), error => error === query.failure)
  assert.equal(query.trace.some(row => row.sql.startsWith('SELECT id::text AS id FROM byos_connections WHERE')), false)
})

test('new prompt reads observe paused credentials and keep concurrent owners separate', async () => {
  const alice = fixture(true, 'alice'), bob = fixture(false, 'bob')
  const [one, other] = await Promise.all([context(alice), context(bob)])
  assert.ok(one.candidates?.every(row => row.source.kind !== 'subscription' || row.source.connectionId === alice.connectionId))
  assert.ok(other.candidates?.every(row => row.source.kind !== 'subscription' || row.source.connectionId === bob.connectionId))
  alice.paused = true
  const next = await context(alice)
  assert.equal(one.entries?.find(row => row.source.kind === 'subscription')?.block?.reason, 'noDevice')
  assert.equal(next.entries?.find(row => row.source.kind === 'subscription')?.block?.reason, 'paused')
})

test('a new Bot starts from the person\'s own run location and effort in this workspace', async () => {
  const scope = { ownerId: 'owner-defaults', workspaceId: 'workspace-defaults' }
  const reads: unknown[][] = []
  const settings = (row: Record<string, unknown> | undefined) => ({ async query(sql: string, args: unknown[] = []) {
    assert.match(sql, /FROM model_order_settings WHERE "ownerId"=\$1 AND "workspaceId"=\$2/)
    reads.push(args)
    return { rows: row ? [row] : [] }
  } })
  const stored = { location: 'local', customized: true, preferredHarness: 'codex', autoModelRouting: false, defaultEffort: 'high', defaultServiceTier: 'fast' }
  assert.deepEqual(await personalRunDefaults(settings(stored) as never, scope), { location: 'local', effort: 'high' })
  // No settings row yet: the dispatcher's defaults, never an empty 「默认」.
  assert.deepEqual(await personalRunDefaults(settings(undefined) as never, scope), { location: 'cloud', effort: 'medium' })
  // A stored effort the dispatcher does not know reads as medium.
  assert.deepEqual(await personalRunDefaults(settings({ ...stored, defaultEffort: 'ludicrous' }) as never, scope), { location: 'local', effort: 'medium' })
  assert.deepEqual(reads, [[scope.ownerId, scope.workspaceId], [scope.ownerId, scope.workspaceId], [scope.ownerId, scope.workspaceId]])
})
