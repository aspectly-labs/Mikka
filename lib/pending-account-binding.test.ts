import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import type { PoolClient } from 'pg'
import { observeCommitEffects } from './db/commit-effects'

let row: Record<string, unknown> = {}
let atDispatch: Record<string, unknown> = {}
let selected = 'account-a'
let actionError: string | null = null
// Provider annotations do not add a separate action approval gate.
let toolTags: string[] | undefined = ['important', 'openWorldHint']
const calls: unknown[][] = []
const client = { query: async () => ({ rows: [], command: 'SELECT' }) } as unknown as PoolClient
observeCommitEffects(client)
const liveEffects: Array<() => Promise<unknown>> = []
// The workspace layer `readWriteSettingLayers` reads (w.external_write_permissions), as the settings page stores it.
let workspacePolicy: Record<string, unknown> | null = null
const db = {
  session: { client },
  transaction: async <T>(operation: (executor: unknown) => Promise<T>): Promise<T> => operation(db),
  $count: async () => 0,
  execute: async () => ({ rows: workspacePolicy === null ? [] : [{ workspace: workspacePolicy }] }),
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
  insert: () => ({ values: async (value: Record<string, unknown>) => { row = { status: 'pending', ...value } } }),
  update: () => ({ set: (value: Record<string, unknown>) => ({ where: () => {
    row = { ...row, ...value }
    return Object.assign(Promise.resolve(), { returning: async () => [row] })
  } }) }),
}
const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports: exports })
stub('./db/index.ts', { db, pool: {} })
stub('./coordinator/decide.ts', { decide: async () => { throw Error('Account writes do not use Decision') } })
stub('./live/scope.ts', { liveGatewayConfig: () => ({ url: 'https://live.example.invalid', secret: 'test-only-live-transport' }) })
stub('./live/notify.ts', { scheduleLive: (work: () => Promise<unknown>) => { liveEffects.push(work) }, sendLiveInvalidations: async () => {} })
stub('./composio.ts', {
  getComposio: () => ({}),
  resolveActionAccount: async (_userId: string, _action: string, requested?: string) => ({ accountId: requested ?? selected, accounts: [] }),
  runComposioAction: async (...args: unknown[]) => {
    calls.push(args)
    const gate = args[4] as ((accountId: string, tool: { tags?: string[]; version?: string }) => Promise<{ error: string } | null>) | undefined
    const stopped = gate ? await gate(String(args[3] ?? selected), { tags: toolTags, version: 'pinned-v1' }) : null
    if (stopped) return stopped
    atDispatch = { ...row }
    return actionError ? { error: actionError } : { data: { summary: 'event' }, accountId: args[3] } },
})
stub('./coordinator-event-store.ts', { recordCoordinatorEvent: async () => {} })
let store: typeof import('./pending-action-store')
before(async () => { store = await import('./pending-action-store') })

test('native mail review retains the exact prepared call and can withhold dispatch', async () => {
  workspacePolicy = { gmail: 'deny' }; row = {}; selected = 'account-native'
  const input = { to: ['recipient@example.invalid'], subject: 'Final subject', body: 'Final text' }
  try {
    let binding: unknown
    const stopped = await store.writeAccountAction('u', 'send_email', input, undefined, BOT, async (decision, prepared) => {
      assert.equal(decision, 'allow'); binding = prepared; return 'deny'
    })
    assert.deepEqual(stopped, { error: 'integrationActionDenied' })
    assert.deepEqual(row, {}, 'a stopped call leaves no receipt and no card')
    assert.deepEqual(binding, { ownerId: 'u', botId: BOT, action: 'send_email', input, accountId: 'account-native', version: 'pinned-v1', policy: null })
    const done = await store.writeAccountAction('u', 'send_email', input, undefined, BOT, async (decision, prepared) => {
      assert.equal(decision, 'allow'); assert.deepEqual(prepared, binding); return 'allow'
    })
    assert.equal('status' in done && done.status, 'done'); assert.equal(row.status, 'done')
  } finally { workspacePolicy = null }
})

test('a Coordinator mail send or calendar write runs at once in the connected account and records its receipt, not a card', async () => {
  selected = 'account-a'; calls.length = 0; row = {}; atDispatch = {}
  const result = await store.writeAccountAction('u', 'send_email', { to: ['recipient@example.invalid'], subject: 's', body: 'b' })
  assert.equal(atDispatch.status, 'running', 'the receipt exists before dispatch')
  assert.equal(atDispatch.botId, null, "the person's own Coordinator")
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], 'send_email')
  assert.equal('status' in result && result.status, 'done')
  assert.equal(row.status, 'done')
  assert.equal(row.connectedAccountId, 'account-a')
  assert.equal(row.decidedAt, undefined, 'no person decided it, so it never reads as an approval')
  assert.equal('actionId' in result && result.actionId, row.id)
  assert.deepEqual(row.result, {})
})

test('a direct write with an unknown outcome stays running and is reported uncertain', async () => {
  calls.length = 0; row = {}; actionError = 'operationUncertain'
  try {
    const result = await store.writeAccountAction('u', 'create_calendar_event', { summary: 'Review', start: '2027-01-01T10:00:00Z', end: '2027-01-01T11:00:00Z' })
    assert.deepEqual(result, { error: 'operationUncertain' })
    assert.equal(row.status, 'running')
    assert.equal(row.error, 'operationUncertain')
  } finally { actionError = null }
})

test('destructive annotations do not interrupt an authorized account write', async () => {
  calls.length = 0; row = {}; toolTags = ['destructiveHint', 'openWorldHint']
  try {
    const result = await store.writeAccountAction('u', 'send_email', { to: ['recipient@example.invalid'], subject: 's', body: 'b' }, 'selected-account')
    assert.equal('status' in result && result.status, 'done')
    assert.equal(row.status, 'done')
    assert.equal(row.connectedAccountId, 'selected-account')
    assert.equal(calls.length, 1)
  } finally { toolTags = ['important', 'openWorldHint'] }
})

const FIRST_CLASS_WRITES = [
  ['send_email', 'gmail', { to: ['recipient@example.invalid'], subject: 's', body: 'b' }],
  ['create_calendar_event', 'googlecalendar', { summary: 'Review', start: '2027-01-01T10:00:00Z', end: '2027-01-01T11:00:00Z' }],
  ['update_calendar_event', 'googlecalendar', { event_id: 'e', summary: 'Review' }],
] as const

const BOT = 'bot-in-workspace'

test('authorized first-class writes run directly regardless of historical action settings, an old ask included', async () => {
  for (const choice of [null, 'allow', 'ask', 'deny']) {
    for (const [action, app, input] of FIRST_CLASS_WRITES) {
      calls.length = 0; row = {}; workspacePolicy = choice ? { [app]: choice } : null
      const result = await store.writeAccountAction('u', action, input, undefined, BOT)
      assert.equal('status' in result && result.status, 'done', `${action}: ${choice}`)
      assert.equal(row.status, 'done')
      assert.equal(calls.length, 1)
    }
  }
  workspacePolicy = null
})
