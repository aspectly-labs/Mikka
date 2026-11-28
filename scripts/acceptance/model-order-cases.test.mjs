import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertRunEvidence, assertWorkspaceIdle, caseOrderPlan, orderFingerprint, ownedSource, providerReceipt, verifyCheckRuns } from './model-order-cases.mjs'

const OWNER = 'acceptance-owner'
const WS = '10000000-0000-4000-8000-000000000001'
const BOT = '10000000-0000-4000-8000-000000000002'
const ISSUE = '10000000-0000-4000-8000-000000000003'
const RUN = '10000000-0000-4000-8000-000000000004'
const KEY = '10000000-0000-4000-8000-000000000005'
const CLAUDE = '10000000-0000-4000-8000-000000000006'
const CODEX = '10000000-0000-4000-8000-000000000007'
const BINDING = '10000000-0000-4000-8000-000000000008'
// The three smoke-owner cases the drivers run (project-decisions.mjs CASES).
const CASES = [
  { id: 'api_deepseek', model: 'deepseek-flash', provider: 'deepseek', harness: 'claude_code', kind: 'api_key' },
  { id: 'official_claude', model: 'claude-haiku-5-5', provider: 'claude', harness: 'claude_code', kind: 'subscription' },
  { id: 'official_codex', model: 'gpt-6-luna', provider: 'codex', harness: 'codex', kind: 'subscription' },
]

function inventory() {
  const candidates = CASES.map((item, index) => ({ harness: item.harness, model: item.model, provider: item.provider,
    credentialOwnerId: OWNER, source: item.kind === 'api_key' ? { kind: item.kind, keyId: KEY } : { kind: item.kind, connectionId: index === 1 ? CLAUDE : CODEX } }))
  const entries = candidates.map((candidate, index) => ({ ...candidate, id: `entry-${index}`, block: null }))
  return { ownerId: OWNER, keys: { keys: [{ id: KEY, provider: 'deepseek' }] },
    connections: { connections: [{ id: CLAUDE, provider: 'claude', state: 'connected', paused: false }, { id: CODEX, provider: 'codex', state: 'connected', paused: false }] },
    order: { location: 'cloud', customized: true, preferredHarness: 'claude_code', cloudReady: true, candidates, entries,
      cloudModels: Object.fromEntries(entries.map(entry => [entry.id, 'ready'])) } }
}

test('source discovery requires the exact small model and an existing own source', () => {
  for (const item of CASES) assert.equal(ownedSource(item, inventory()).model, item.model)
  const shared = inventory()
  shared.order.candidates[0].credentialOwnerId = 'other-member'
  assert.throws(() => ownedSource(CASES[0], shared), /source_missing/)
  const changed = inventory()
  changed.order.candidates[1].model = 'claude-opus'
  assert.throws(() => ownedSource(CASES[1], changed), /source_missing/)
  const absent = inventory()
  absent.keys.keys = []
  assert.throws(() => ownedSource(CASES[0], absent), /source_missing/)
  const stale = inventory()
  stale.order.entries[2].block = { reason: 'quota' }
  assert.throws(() => ownedSource(CASES[2], stale), error => error.message === 'source_blocked' && error.detail.block === 'quota')
})

test('the order comparison includes identities, harness, order and location but not changing health projections', () => {
  const before = inventory().order
  const after = structuredClone(before)
  after.entries[0].block = { reason: 'balance' }
  assert.equal(orderFingerprint(before), orderFingerprint(after))
  after.entries.reverse()
  assert.notEqual(orderFingerprint(before), orderFingerprint(after))
  after.entries.reverse(); after.entries[0].source.keyId = CODEX
  assert.notEqual(orderFingerprint(before), orderFingerprint(after))
  after.entries[0].source.keyId = KEY; after.location = 'local'
  assert.notEqual(orderFingerprint(before), orderFingerprint(after))
})

test('every case limits the producer and later Factory selections to its exact own small-model order', () => {
  const state = inventory()
  const opus = { ...state.order.candidates[1], model: 'claude-opus', source: { kind: 'subscription', connectionId: BINDING }, credentialOwnerId: 'other-member' }
  state.order.candidates.push(opus)
  state.order.entries.unshift({ ...opus, id: 'shared-opus', block: null })
  for (const item of CASES.slice(1)) {
    const selected = ownedSource(item, state)
    const plan = caseOrderPlan(state.order, [selected], OWNER)
    assert.equal(plan.already, false)
    assert.deepEqual(plan.wanted.map(entry => [entry.model, entry.credentialOwnerId]), [[item.model, OWNER]])
    assert.throws(() => caseOrderPlan({ ...state.order, customized: false }, [selected], OWNER), /order_restore_unavailable/)
  }
  const first = ownedSource(CASES[0], state), next = ownedSource(CASES[2], state)
  const fallback = caseOrderPlan(state.order, [first, next], OWNER)
  assert.deepEqual(fallback.wanted.map(entry => entry.model), ['deepseek-flash', 'gpt-6-luna'])
  assert.throws(() => caseOrderPlan(state.order, [{ ...next, credentialOwnerId: 'other-member' }], OWNER), /run_identity/)
})

function evidence(item = CASES[1]) {
  const resourceId = item.kind === 'api_key' ? KEY : BINDING
  return { run: { id: RUN, issueId: ISSUE, botId: BOT, status: 'succeeded', model: item.model, harness: item.harness,
    credentialType: item.kind, subscriptionRoute: item.kind === 'api_key' ? null : item.harness === 'codex' ? 'codex_cli' : 'claude_code_cli',
    executionIdentity: { version: 1, requester: OWNER, executionPrincipal: OWNER, outputOwner: OWNER, botId: BOT, botOwner: OWNER,
      workspaceId: WS, personalResourcePolicy: 'requester_only',
      resourceBindings: [{ kind: item.kind, id: resourceId, ownerId: OWNER, access: 'owner' }],
      billingAccount: { model: { kind: item.kind, ownerId: OWNER, resourceId }, runtime: { kind: 'e2b', ownerId: OWNER } } } }, artifacts: [] }
}
const scope = (item = CASES[1]) => ({ ownerId: OWNER, workspaceId: WS, botId: BOT, issueId: ISSUE, model: item.model, harness: item.harness, kind: item.kind, keyId: KEY })

test('frozen execution evidence must match owner, workspace, bot, model and official CLI route', () => {
  for (const item of CASES) assert.equal(assertRunEvidence(evidence(item), scope(item)).model, item.model)
  for (const mutate of [
    value => { value.run.botId = CODEX }, value => { value.run.issueId = CODEX },
    value => { value.run.model = 'claude-opus' }, value => { value.run.subscriptionRoute = 'openai_siwc' },
    value => { value.run.credentialType = 'api_key' },
    value => { value.run.executionIdentity.workspaceId = CODEX },
    value => { value.run.executionIdentity.requester = 'other-user' },
    value => { value.run.executionIdentity.billingAccount.model.ownerId = 'other-user' },
    value => { value.run.executionIdentity.resourceBindings[0].access = 'workspace_share' },
    value => { value.run.executionIdentity.billingAccount.runtime.ownerId = 'other-user' },
  ]) { const value = evidence(); mutate(value); assert.throws(() => assertRunEvidence(value, scope())) }
  const wrongKey = evidence(CASES[0]); wrongKey.run.executionIdentity.billingAccount.model.resourceId = CODEX
  assert.throws(() => assertRunEvidence(wrongKey, scope(CASES[0])), /run_identity/)
})

test('passed review and verify receipts still require actual small-model, own-source and native-route evidence', async () => {
  const checks = [{ stage: 'review', runId: RUN }, { stage: 'verify', runId: KEY }]
  for (const item of CASES.slice(1)) {
    const read = async runId => { const found = evidence(item); found.run.id = runId; return found }
    const accepted = await verifyCheckRuns(checks, scope(item), read)
    assert.deepEqual(accepted.map(check => [check.stage, check.model, check.subscriptionRoute]),
      checks.map(check => [check.stage, item.model, item.harness === 'codex' ? 'codex_cli' : 'claude_code_cli']))
    for (const mutate of [
      found => { found.run.model = item.harness === 'codex' ? 'gpt-other' : 'claude-opus' },
      found => { found.run.credentialType = 'api_key'; found.run.subscriptionRoute = null },
      found => { found.run.subscriptionRoute = 'openai_siwc' },
      found => { found.run.executionIdentity.billingAccount.model.ownerId = 'shared-owner' },
      found => { found.run.executionIdentity.resourceBindings[0].access = 'workspace_share' },
      found => { found.run.executionIdentity.workspaceId = CODEX },
    ]) await assert.rejects(verifyCheckRuns(checks, scope(item), async runId => {
      const found = await read(runId)
      if (runId === KEY) mutate(found)
      return found
    }))
  }
})

test('only host terminal provider chunks produce provider evidence', () => {
  const host = { type: 'data-run-state', data: { state: 'failed', stopReason: 'provider_failure', error: 'Model provider failed (balance: insufficient_balance; HTTP 402)' } }
  assert.deepEqual(providerReceipt({ chunks: [{ chunk: host }] }), { kind: 'balance', code: 'insufficient_balance', status: 402 })
  assert.equal(providerReceipt({ chunks: [{ chunk: { type: 'text-delta', delta: host.data.error } }] }), null)
  assert.equal(providerReceipt({ chunks: [{ chunk: { ...host, data: { ...host.data, stopReason: 'error' } } }] }), null)
  assert.equal(providerReceipt({ chunks: [{ chunk: { ...host, data: { ...host.data, state: 'cancelled' } } }] }), null)
  assert.equal(providerReceipt({ chunks: [{ chunk: { ...host, data: { ...host.data, error: 'HTTP 402 Authorization: secret' } } }] }), null)
})

test('only an idle workspace with well-formed activity passes; nothing else is assumed idle', async () => {
  const reader = (bots, threads) => async path => path === '/api/settings/workspace-bots' ? bots : { threads }
  await assertWorkspaceIdle(reader({ bots: [{ status: 'idle', runningThreads: 0 }] }, [{ status: 'done' }]))
  for (const [bots, threads] of [
    [{ bots: [{ status: 'running', runningThreads: 1 }] }, []], [{ bots: [{ status: 'idle', runningThreads: 1 }] }, []],
    [{ bots: [] }, [{ status: 'paused' }]], [{ bots: [] }, [{ status: 'waiting' }]],
  ]) await assert.rejects(assertWorkspaceIdle(reader(bots, threads)), /workspace_busy/)
  for (const [bots, threads] of [
    [null, []], [{ bots: null }, []], [{ bots: [null] }, []], [{ bots: [{ status: 'idle', runningThreads: '0' }] }, []],
    [{ bots: [{ status: 'unknown', runningThreads: 0 }] }, []], [{ bots: [] }, null], [{ bots: [] }, [{ status: 'unknown' }]],
  ]) await assert.rejects(assertWorkspaceIdle(reader(bots, threads)), /response_invalid/)
})
