import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import pg from 'pg'
import { createApprovedWrites } from './approved-writes'
import { createReadbackAuthority } from './write-readback-authority'
import { acquireWorkspaceMembership } from '../workspace-membership-guard'
import { sweepWriteReceipts } from './write-receipt-sweep'
import { createOperationLedger, type OperationIntent } from './ledger'
import { DEFAULT_AGENT_DEFINITION } from '../agent-kit/builtin'
import { digest, makeSnapshot } from '../agent-kit/definition'
import { recoveryHttpProvider, recoverySlackProvider } from '../../tests/fixtures/operation-recovery'
import { validateTarget } from '../../scripts/run-db-tests.mjs'

const action = 'append_notion_paragraph'
const fixtureFile = fileURLToPath(new URL('../../tests/fixtures/operation-recovery.ts', import.meta.url))
const preload = fileURLToPath(new URL('../../tests/support/server-only.mjs', import.meta.url))

function message(child: ChildProcess, kind: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error(`fixture ${kind} deadline`)), 10_000)
    const receive = (value: Record<string, string>) => { if (value?.kind === kind) finish(undefined, value) }
    const failed = () => finish(Error(`fixture exited before ${kind}`))
    const finish = (error?: Error, value?: Record<string, string>) => {
      clearTimeout(timer); child.off('message', receive); child.off('exit', failed)
      if (error) reject(error); else resolve(value!)
    }
    child.on('message', receive); child.once('exit', failed)
  })
}
function child(mode: 'server' | 'worker', env: Partial<NodeJS.ProcessEnv> = {}) {
  return fork(fixtureFile, [mode], { execArgv: ['--import', preload, '--import', 'tsx'], env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
}
async function stop(process: ChildProcess) {
  if (process.exitCode !== null || process.signalCode !== null) return
  const exited = once(process, 'exit')
  process.kill('SIGKILL')
  await exited
}
async function fixture() {
  validateTarget(process.env)
  assert.equal(process.env.REQUIRE_DB, '1')
  const schema = 'operation208_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1 })
  let pool: pg.Pool | undefined, server: ChildProcess | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const ownedPool = pool = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, options: `-c search_path=${schema},pg_catalog`, max: 12 })
    await ownedPool.query(`CREATE TABLE "session" (id text primary key,"userId" text not null,"expiresAt" timestamptz not null);
      CREATE TABLE agent_kit_heads (owner_id text,bot_key text,workspace_id uuid,active_version uuid,PRIMARY KEY(owner_id,bot_key));
      CREATE TABLE agent_kit_versions(owner_id text,bot_key text,id uuid,definition jsonb,digest text);
      CREATE TABLE agent_kit_executions(owner_id text,bot_key text,id uuid,status text,snapshot jsonb,version_id uuid);
      CREATE TABLE composio_accounts ("accountId" text PRIMARY KEY,"userId" text NOT NULL,"needsReconnectAt" timestamptz);
      CREATE TABLE mikka_workspace_members ("workspaceId" uuid NOT NULL,"userId" text NOT NULL,status text NOT NULL,PRIMARY KEY("workspaceId","userId"))`)
    for (const name of ['20261025043000_pending_actions.sql', '20261028143920_operation_ledger.sql', '20261028143921_approved_write_binding.sql', '20261029043646_agent_external_write_policy.sql', '20261127173451_pending_actions_readback_attempt.sql']) {
      await ownedPool.query(await readFile(new URL('../../drizzle/' + name, import.meta.url), 'utf8'))
    }
    const ownedServer = server = child('server')
    const { origin } = await message(ownedServer, 'ready')
    console.log(`Retained operation recovery schema ${schema}; loopback effect process ${origin}`)
    return { schema, pool: ownedPool, origin, async close() { await stop(ownedServer); await ownedPool.end(); await admin.end() } }
  } catch (error) {
    await Promise.allSettled([server && stop(server), pool?.end(), admin.end()])
    throw error
  }
}

/** The production readback authority over the fixture schema (main and workspace tables share it here). */
function readbackAuthority(pool: pg.Pool) {
  return createReadbackAuthority(pool, pool, identity => (_tx, signal) => acquireWorkspaceMembership(pool, identity, signal))
}

for (const transport of ['generic', 'slack'] as const) test(`${transport}: ten concurrent callers and a new run retain one logical operation and effect`, { timeout: 30_000 }, async () => {
  const f = await fixture()
  try {
    const provider = transport === 'slack' ? await recoverySlackProvider(f.origin) : recoveryHttpProvider(f.origin)
    const payload = transport === 'slack' ? { channel: 'C12345678', text: 'Controlled local recovery effect' } : {}
    const selected = await provider.prepare('owner', payload)
    const run = randomUUID(), id = randomUUID()
    const binding: OperationIntent = { operationId: id, ownerId: 'owner', workspaceId: 'personal:owner', provider: provider.name, accountId: selected.accountId, action: transport === 'slack' ? 'send_slack_message' : action, target: 'owned-target', approvalId: id, proposalDigest: 'a'.repeat(64), payloadDigest: 'b'.repeat(64) }
    const key = { operationId: id, ownerId: binding.ownerId, workspaceId: binding.workspaceId }
    const authorize = async (_tx: pg.PoolClient, intent: OperationIntent) => {
      if (intent.ownerId !== binding.ownerId || intent.workspaceId !== binding.workspaceId || intent.approvalId !== id) throw Error('fixture authority denied')
    }
    const ledger = createOperationLedger(f.pool, authorize)
    const reservations = await Promise.all(Array.from({ length: 10 }, () => ledger.reserve(binding)))
    assert.equal(new Set(reservations.map(row => row.idempotencyKey)).size, 1)
    const claims = await Promise.allSettled(Array.from({ length: 10 }, () => ledger.claim(key, run)))
    const winner = claims.filter((row): row is PromiseFulfilledResult<Awaited<ReturnType<typeof ledger.claim>>> => row.status === 'fulfilled')
    assert.equal(winner.length, 1)
    const pending = await ledger.reconcile(key, record => provider.lookup({ ownerId: binding.ownerId, accountId: binding.accountId, version: selected.version, payload, idempotencyKey: record.idempotencyKey }))
    assert.equal(pending.status, 'executing', 'a negative lookup must not invalidate the winner before its first invocation')
    await ledger.invoke(key, winner[0].value.attemptToken!, async (row, beforeSend, signal) => provider.execute({ ownerId: binding.ownerId, accountId: binding.accountId, version: selected.version, payload, approvalContext: selected.context ?? null, idempotencyKey: row.idempotencyKey, beforeSend, signal }))
    const restarted = createOperationLedger(f.pool, authorize)
    assert.equal((await restarted.reserve(binding)).status, 'succeeded')
    await assert.rejects(restarted.claim(key, randomUUID()), /operationAlreadyClaimed/)
    await assert.rejects(restarted.reserve({ ...binding, payloadDigest: 'c'.repeat(64) }), /operationBindingConflict/)
    await assert.rejects(restarted.read({ ...key, ownerId: 'other' }), /operationUnavailable/)
    assert.deepEqual(await (await fetch(f.origin + '/stats')).json(), { posts: 1, effects: 1 })
    assert.equal(Number((await f.pool.query('SELECT count(*) FROM operation_ledger')).rows[0].count), 1)
  } finally { await f.close() }
})

for (const transport of ['generic', 'slack'] as const) test(`${transport}: after its worker dies, the same run reads the effect back and never resends it`, { timeout: 30_000 }, async () => {
  const f = await fixture()
  let worker: ChildProcess | undefined
  try {
    const run = randomUUID(), revision = randomUUID(), intentKey = randomUUID(), page = randomUUID()
    const action = transport === 'slack' ? 'send_slack_message' : 'append_notion_paragraph'
    const payload = { ...(transport === 'slack' ? { channel: 'C12345678' } : { page_id: page }), text: 'Controlled local recovery effect' }
    const ownerId = 'recovery-owner', actor = { userId: ownerId, sessionId: 'recovery-session' }
    const definition = { ...DEFAULT_AGENT_DEFINITION, tools: [action] }
    const snapshot = makeSnapshot(revision, 1, definition, 'controlled local fixture', { harness: 'ai_sdk', model: 'openai/gpt-6-luna' })
    await f.pool.query('INSERT INTO "session" VALUES($1,$2,now()+interval \'1 hour\')', [actor.sessionId, ownerId])
    await f.pool.query('INSERT INTO agent_kit_heads(owner_id,bot_key,active_version,external_write_permissions) VALUES($1,\'coordinator\',$2,$3)', [ownerId, revision, { [action]: 'allow' }])
    await f.pool.query('INSERT INTO agent_kit_versions VALUES($1,\'coordinator\',$2,$3,$4)', [ownerId, revision, definition, digest(definition)])
    await f.pool.query('INSERT INTO agent_kit_executions VALUES($1,\'coordinator\',$2,\'running\',$3,$4)', [ownerId, run, snapshot, revision])
    worker = child('worker', { OPERATION_RECOVERY_SCHEMA: f.schema, OPERATION_RECOVERY_ORIGIN: f.origin, OPERATION_RECOVERY_RUN: run, OPERATION_RECOVERY_PAGE: page, OPERATION_RECOVERY_INTENT: intentKey, OPERATION_RECOVERY_PROVIDER: transport })
    await message(worker, 'effect-applied')
    await stop(worker)
    const before = (await f.pool.query('SELECT * FROM operation_ledger')).rows[0]
    assert.equal(before.status, 'executing')
    assert.ok(before.invokedAt)
    // The receipt was written running, with no approval decision, before dispatch.
    const proposal = (await f.pool.query('SELECT id,status,"decidedAt" FROM pending_actions')).rows[0]
    assert.equal(proposal.status, 'running'); assert.equal(proposal.decidedAt, null)
    let lookups = 0
    const provider = transport === 'slack' ? await recoverySlackProvider(f.origin) : recoveryHttpProvider(f.origin)
    const counted = { ...provider, lookup: async (input: Parameters<typeof provider.lookup>[0]) => { lookups++; return provider.lookup(input) } }
    const reader = createApprovedWrites(f.pool, counted, action, {})
    assert.equal((await reader.view(actor, proposal.id)).status, 'running')
    await assert.rejects(reader.view({ ...actor, userId: 'other' }, proposal.id))
    assert.equal(lookups, 0)
    let guardedLookups = 0
    const guarded = createOperationLedger(f.pool, async () => {}, { guard: async () => { throw Error('fixtureMembershipRevoked') } })
    await assert.rejects(guarded.reconcile({ operationId: before.operationId, ownerId, workspaceId: `personal:${ownerId}` }, async () => { guardedLookups++; return null }), /fixtureMembershipRevoked/)
    assert.equal(guardedLookups, 0, 'membership lease must precede remote readback')
    const newRun = randomUUID()
    const retry = createApprovedWrites(f.pool, counted, action, { modelRun: { ownerId, botId: null, workspaceId: null, runId: newRun } })
    await assert.rejects(retry.writeFromRun(payload, intentKey), /operationBindingConflict/)
    const replay = createApprovedWrites(f.pool, counted, action, { modelRun: { ownerId, botId: null, workspaceId: null, runId: run } })
    const result = await replay.writeFromRun(payload, intentKey)
    assert.equal(result.status, 'done')
    const after = (await f.pool.query('SELECT * FROM operation_ledger')).rows[0]
    assert.equal(after.operationId, before.operationId)
    assert.equal(after.idempotencyKey, before.idempotencyKey)
    assert.equal(after.runId, run)
    assert.equal(after.binding.executionRunId, run)
    assert.equal(after.status, 'succeeded')
    const expectedOutcome = { id: after.receipt.providerObjectId, ...(transport === 'slack' ? { url: `https://fixture.slack.com/archives/C12345678/p${after.receipt.providerObjectId.replace('.', '')}` } : {}) }
    assert.ok('outcome' in result); assert.deepEqual(result.outcome, expectedOutcome)
    assert.deepEqual((await reader.view(actor, proposal.id)).outcome, expectedOutcome)
    assert.equal((await replay.writeFromRun(payload, intentKey)).status, 'done')
    assert.equal(lookups, 1)
    const ledger = createOperationLedger(f.pool, async () => {})
    await assert.rejects(ledger.claim({ operationId: after.operationId, ownerId, workspaceId: `personal:${ownerId}` }, randomUUID()), /operationRunMismatch/)
    await f.pool.query("UPDATE agent_kit_executions SET status='failed' WHERE id=$1", [run])
    await assert.rejects(replay.writeFromRun(payload, intentKey), /writeRunUnavailable/)
    assert.equal(lookups, 1)
    assert.deepEqual(await (await fetch(f.origin + '/stats')).json(), { posts: 1, effects: 1 })
  } finally { if (worker) await stop(worker); await f.close() }
})

for (const transport of ['generic', 'slack'] as const) test(`${transport}: after its worker dies and its run ends, the sweep reads the effect back, never resends, and closes an unsent receipt`, { timeout: 30_000 }, async () => {
  const f = await fixture()
  let worker: ChildProcess | undefined
  try {
    const run = randomUUID(), revision = randomUUID(), intentKey = randomUUID(), page = randomUUID()
    const action = transport === 'slack' ? 'send_slack_message' : 'append_notion_paragraph'
    const payload = { ...(transport === 'slack' ? { channel: 'C12345678' } : { page_id: page }), text: 'Controlled local recovery effect' }
    const ownerId = 'recovery-owner', actor = { userId: ownerId, sessionId: 'recovery-session' }
    const definition = { ...DEFAULT_AGENT_DEFINITION, tools: [action] }
    const snapshot = makeSnapshot(revision, 1, definition, 'controlled local fixture', { harness: 'ai_sdk', model: 'openai/gpt-6-luna' })
    await f.pool.query('INSERT INTO "session" VALUES($1,$2,now()+interval \'1 hour\')', [actor.sessionId, ownerId])
    await f.pool.query('INSERT INTO agent_kit_heads(owner_id,bot_key,active_version,external_write_permissions) VALUES($1,\'coordinator\',$2,$3)', [ownerId, revision, { [action]: 'allow' }])
    await f.pool.query('INSERT INTO agent_kit_versions VALUES($1,\'coordinator\',$2,$3,$4)', [ownerId, revision, definition, digest(definition)])
    await f.pool.query('INSERT INTO agent_kit_executions VALUES($1,\'coordinator\',$2,\'running\',$3,$4)', [ownerId, run, snapshot, revision])
    worker = child('worker', { OPERATION_RECOVERY_SCHEMA: f.schema, OPERATION_RECOVERY_ORIGIN: f.origin, OPERATION_RECOVERY_RUN: run, OPERATION_RECOVERY_PAGE: page, OPERATION_RECOVERY_INTENT: intentKey, OPERATION_RECOVERY_PROVIDER: transport })
    await message(worker, 'effect-applied')
    await stop(worker)
    // The run ends with the effect sent but unrecorded, and its settings change afterwards.
    await f.pool.query("UPDATE agent_kit_executions SET status='failed' WHERE id=$1", [run])
    await f.pool.query('UPDATE agent_kit_heads SET external_write_permissions=$1 WHERE owner_id=$2', [{ [action]: 'deny' }, ownerId])
    const receipt = (await f.pool.query('SELECT id FROM pending_actions')).rows[0]
    let lookups = 0, readbacks = 0
    const provider = transport === 'slack' ? await recoverySlackProvider(f.origin) : recoveryHttpProvider(f.origin)
    const counted = { ...provider, lookup: async (input: Parameters<typeof provider.lookup>[0]) => { lookups++; return provider.lookup(input) } }
    const service = createApprovedWrites(f.pool, counted, action, { readbackAuthority: readbackAuthority(f.pool) })
    const readback = (owner: string, id: string) => { readbacks++; return service.readback(owner, id) }
    // Without the owner's current authority nothing reads the provider.
    await assert.rejects(createApprovedWrites(f.pool, counted, action, {}).readback(ownerId, receipt.id), /writePolicyUnavailable/)
    assert.equal(lookups, 0)
    const replay = createApprovedWrites(f.pool, counted, action, { modelRun: { ownerId, botId: null, workspaceId: null, runId: run } })
    await assert.rejects(replay.writeFromRun(payload, intentKey), /writeRunUnavailable/)
    assert.equal(lookups, 0)

    // A receipt committed just before its run ended, with no ledger row: it was never sent.
    const unsent = randomUUID()
    await f.pool.query(`INSERT INTO pending_actions (id,"userId",action,input,"intentKey","operationBinding",context,status)
      SELECT $1,"userId",action,input,$2,"operationBinding",context,'running' FROM pending_actions WHERE id=$3`, [unsent, randomUUID(), receipt.id])
    // A late proposal from an older deployment during the rollout.
    const late = randomUUID()
    await f.pool.query(`INSERT INTO pending_actions (id,"userId",action,input,status) VALUES ($1,$2,'send_email','{}','pending')`, [late, ownerId])
    // A late browser action holding its executable mutation: closed and stripped in the same statement.
    const lateBrowser = randomUUID()
    await f.pool.query(`INSERT INTO pending_actions (id,"userId",action,input,status) VALUES ($1,$2,'browser_operation',$3,'pending')`, [lateBrowser, ownerId, { mutation: { kind: 'click' }, summary: 'Click Save', digest: 'd'.repeat(64) }])

    const swept = await sweepWriteReceipts(f.pool, readback)
    assert.deepEqual(swept, { retired: 2, readBack: 2, outcomes: { done: 1, failed: 1 } })
    assert.deepEqual((await f.pool.query('SELECT status,error,input FROM pending_actions WHERE id=$1', [lateBrowser])).rows[0],
      { status: 'declined', error: 'approvalRetired', input: { summary: 'Click Save', digest: 'd'.repeat(64), mutationScrubbed: true } })
    assert.equal(lookups, 1, 'one readback of the sent effect')
    const status = async (id: string) => (await f.pool.query('SELECT status,error FROM pending_actions WHERE id=$1', [id])).rows[0]
    assert.deepEqual(await status(receipt.id), { status: 'done', error: null })
    assert.deepEqual(await status(unsent), { status: 'failed', error: 'writeRunEnded' })
    assert.deepEqual(await status(late), { status: 'declined', error: 'approvalRetired' })
    const ledger = (await f.pool.query('SELECT status,receipt FROM operation_ledger')).rows
    assert.equal(ledger.length, 1); assert.equal(ledger[0].status, 'succeeded')
    assert.equal((await service.view(actor, receipt.id)).status, 'done')
    assert.equal((await service.view(actor, unsent)).status, 'declined', 'an unsent write reads as did-not-run')

    // Idempotent: a second sweep finds nothing to do and sends nothing.
    assert.deepEqual(await sweepWriteReceipts(f.pool, readback), { retired: 0, readBack: 0, outcomes: {} })
    assert.equal(readbacks, 2); assert.equal(lookups, 1)
    assert.deepEqual(await (await fetch(f.origin + '/stats')).json(), { posts: 1, effects: 1 })
  } finally { if (worker) await stop(worker); await f.close() }
})

/** A write the worker sent before it died, recorded nowhere but the ledger's
 * invoke gate, whose run then ended. With `workspace`, a Bot's run in a
 * workspace the owner is an active member of. */
async function sentAndEnded(f: Awaited<ReturnType<typeof fixture>>, transport: 'generic' | 'slack', workspace?: { workspaceId: string; botId: string }) {
  const run = randomUUID(), revision = randomUUID(), intentKey = randomUUID(), page = randomUUID()
  const action = transport === 'slack' ? 'send_slack_message' : 'append_notion_paragraph'
  const ownerId = 'recovery-owner', actor = { userId: ownerId, sessionId: `recovery-session-${run}` }, key = workspace?.botId ?? 'coordinator'
  const definition = { ...DEFAULT_AGENT_DEFINITION, tools: [action] }
  const snapshot = makeSnapshot(revision, 1, definition, 'controlled local fixture', { harness: 'ai_sdk', model: 'openai/gpt-6-luna' })
  await f.pool.query('INSERT INTO "session" VALUES($1,$2,now()+interval \'1 hour\')', [actor.sessionId, ownerId])
  await f.pool.query('INSERT INTO agent_kit_heads(owner_id,bot_key,workspace_id,active_version) VALUES($1,$2,$3,$4)', [ownerId, key, workspace?.workspaceId ?? null, revision])
  await f.pool.query('INSERT INTO agent_kit_versions VALUES($1,$2,$3,$4,$5)', [ownerId, key, revision, definition, digest(definition)])
  await f.pool.query('INSERT INTO agent_kit_executions VALUES($1,$2,$3,\'running\',$4,$5)', [ownerId, key, run, snapshot, revision])
  if (workspace) await f.pool.query('INSERT INTO mikka_workspace_members VALUES($1,$2,\'active\')', [workspace.workspaceId, ownerId])
  const worker = child('worker', { OPERATION_RECOVERY_SCHEMA: f.schema, OPERATION_RECOVERY_ORIGIN: f.origin, OPERATION_RECOVERY_RUN: run, OPERATION_RECOVERY_PAGE: page, OPERATION_RECOVERY_INTENT: intentKey, OPERATION_RECOVERY_PROVIDER: transport, ...(workspace ? { OPERATION_RECOVERY_WORKSPACE: workspace.workspaceId, OPERATION_RECOVERY_BOT: workspace.botId } : {}) })
  try { await message(worker, 'effect-applied') } finally { await stop(worker) }
  await f.pool.query("UPDATE agent_kit_executions SET status='failed' WHERE id=$1", [run])
  const receipt = (await f.pool.query<{ id: string; accountId: string }>('SELECT id,"operationBinding"->>\'accountId\' AS "accountId" FROM pending_actions WHERE "intentKey"=$1', [intentKey])).rows[0]
  const ledger = (await f.pool.query('SELECT status,"invokedAt" FROM operation_ledger WHERE "operationId"=$1', [receipt.id])).rows[0]
  assert.equal(ledger.status, 'executing'); assert.ok(ledger.invokedAt, 'the effect was sent before the worker died')
  let lookups = 0
  const provider = transport === 'slack' ? await recoverySlackProvider(f.origin) : recoveryHttpProvider(f.origin)
  const counted = { ...provider, lookup: async (input: Parameters<typeof provider.lookup>[0]) => { lookups++; return provider.lookup(input) } }
  const service = createApprovedWrites(f.pool, counted, action, { readbackAuthority: readbackAuthority(f.pool) })
  const status = async (id: string) => (await f.pool.query('SELECT status,error FROM pending_actions WHERE id=$1', [id])).rows[0]
  const copy = async (createdAt = 'now()'): Promise<string> => {
    const id: string = randomUUID()
    await f.pool.query(`INSERT INTO pending_actions (id,"userId",action,input,"intentKey","operationBinding",context,status,"createdAt")
      SELECT $1,"userId",action,input,$2,"operationBinding",context,'running',${createdAt} FROM pending_actions WHERE id=$3`, [id, randomUUID(), receipt.id])
    return id
  }
  return { ownerId, actor, receipt, service, status, copy, lookups: () => lookups }
}
const effects = async (origin: string) => (await fetch(origin + '/stats')).json()

test('generic: receipts no readback can settle do not starve a newer receipt, and a receipt just tried waits five minutes', { timeout: 30_000 }, async () => {
  const f = await fixture()
  try {
    const sent = await sentAndEnded(f, 'generic')
    // Older receipts whose provider readback keeps failing (as Notion and Calendar never return evidence).
    const stuck = [await sent.copy("now()-interval '3 hours'"), await sent.copy("now()-interval '2 hours'"), await sent.copy("now()-interval '1 hour'")]
    const tried: string[] = []
    const readback = async (owner: string, id: string) => {
      tried.push(id)
      if (stuck.includes(id)) throw Error('fixture provider readback unavailable: secret-token-never-reported')
      return sent.service.readback(owner, id)
    }
    const first = await sweepWriteReceipts(f.pool, readback, { limit: 3 })
    assert.deepEqual(first, { retired: 0, readBack: 3, outcomes: { unavailable: 3 }, failures: { Error: 3 } })
    assert.ok(!JSON.stringify(first).includes('secret'), 'a failure is reported by name or code, never its message')
    assert.deepEqual(tried, stuck, 'the oldest untried receipts first')
    const attempts = (await f.pool.query('SELECT id,status,"readbackAttemptAt" FROM pending_actions')).rows
    for (const row of attempts) {
      assert.equal(row.status, 'running', 'a failed readback never closes a receipt')
      assert.equal(Boolean(row.readbackAttemptAt), stuck.includes(row.id), 'each pick is stamped before its readback')
    }
    // The next sweep, even at once, reads the untried receipt and skips the ones just tried.
    tried.length = 0
    assert.deepEqual(await sweepWriteReceipts(f.pool, readback, { limit: 3 }), { retired: 0, readBack: 1, outcomes: { done: 1 } })
    assert.deepEqual(tried, [sent.receipt.id])
    assert.deepEqual(await sent.status(sent.receipt.id), { status: 'done', error: null })
    // Once five minutes have passed, the one tried longest ago goes first; one tried since still waits.
    await f.pool.query(`UPDATE pending_actions SET "readbackAttemptAt"=now()-interval '30 minutes' WHERE id=$1`, [stuck[2]])
    await f.pool.query(`UPDATE pending_actions SET "readbackAttemptAt"=now()-interval '20 minutes' WHERE id=$1`, [stuck[0]])
    tried.length = 0
    assert.deepEqual(await sweepWriteReceipts(f.pool, readback, { limit: 1 }), { retired: 0, readBack: 1, outcomes: { unavailable: 1 }, failures: { Error: 1 } })
    assert.deepEqual(tried, [stuck[2]])
    tried.length = 0
    assert.deepEqual(await sweepWriteReceipts(f.pool, readback, { limit: 3 }), { retired: 0, readBack: 1, outcomes: { unavailable: 1 }, failures: { Error: 1 } })
    assert.deepEqual(tried, [stuck[0]], 'stuck[1] and stuck[2] were tried within five minutes')
    for (const id of stuck) assert.equal((await sent.status(id)).status, 'running')
    assert.equal(sent.lookups(), 1)
    assert.deepEqual(await effects(f.origin), { posts: 1, effects: 1 })
  } finally { await f.close() }
})

for (const transport of ['generic', 'slack'] as const) test(`${transport}: after a Bot is taken over, its old owner's receipts end without any readback or resend`, { timeout: 30_000 }, async () => {
  const f = await fixture()
  try {
    const sent = await sentAndEnded(f, transport, { workspaceId: randomUUID(), botId: randomUUID() })
    const unsent = await sent.copy()
    // transferBots (lib/workspace-admin/members.ts) deletes the old owner's agent
    // head; its versions and runs go with it (ON DELETE CASCADE).
    await f.pool.query('DELETE FROM agent_kit_executions WHERE owner_id=$1', [sent.ownerId])
    await f.pool.query('DELETE FROM agent_kit_versions WHERE owner_id=$1', [sent.ownerId])
    await f.pool.query('DELETE FROM agent_kit_heads WHERE owner_id=$1', [sent.ownerId])
    const readback = (owner: string, id: string) => sent.service.readback(owner, id)
    assert.deepEqual(await sweepWriteReceipts(f.pool, readback), { retired: 0, readBack: 2, outcomes: { failed: 2 } })
    assert.deepEqual(await sent.status(sent.receipt.id), { status: 'failed', error: 'writeUnconfirmed' })
    assert.deepEqual(await sent.status(unsent), { status: 'failed', error: 'writeRunEnded' })
    // A sent write that can no longer be read back keeps an unknown outcome, never "did not run".
    const view = await sent.service.view(sent.actor, sent.receipt.id)
    assert.deepEqual([view.status, view.error], ['running', 'operationUncertain'])
    assert.equal((await sent.service.view(sent.actor, unsent)).status, 'declined')
    assert.equal(sent.lookups(), 0, 'no provider readback through a binding that is gone')
    assert.deepEqual(await sweepWriteReceipts(f.pool, readback), { retired: 0, readBack: 0, outcomes: {} })
    assert.equal((await f.pool.query("SELECT status FROM operation_ledger")).rows[0].status, 'executing', 'the ledger keeps its record')
    assert.deepEqual(await effects(f.origin), { posts: 1, effects: 1 })
  } finally { await f.close() }
})

for (const transport of ['generic', 'slack'] as const) for (const change of ['none', 'removed-member', 'revoked-connection', 'transferred-connection'] as const) test(`${transport}: readback after the run ended with ${change === 'none' ? 'the owner still a member and connected' : change} ${change === 'none' ? 'reads the effect back' : 'closes the receipt unconfirmed without reading the provider'}`, { timeout: 30_000 }, async () => {
  const f = await fixture()
  try {
    const workspaceId = randomUUID()
    const sent = await sentAndEnded(f, transport, { workspaceId, botId: randomUUID() })
    if (change === 'removed-member') await f.pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, sent.ownerId])
    if (change === 'revoked-connection') await f.pool.query('INSERT INTO composio_accounts VALUES($1,$2,now())', [sent.receipt.accountId, sent.ownerId])
    if (change === 'transferred-connection') await f.pool.query('INSERT INTO composio_accounts VALUES($1,\'someone-else\',NULL)', [sent.receipt.accountId])
    const readback = (owner: string, id: string) => sent.service.readback(owner, id)
    if (change === 'none') {
      await f.pool.query('INSERT INTO composio_accounts VALUES($1,$2,NULL)', [sent.receipt.accountId, sent.ownerId])
      assert.deepEqual(await sweepWriteReceipts(f.pool, readback), { retired: 0, readBack: 1, outcomes: { done: 1 } })
      assert.deepEqual(await sent.status(sent.receipt.id), { status: 'done', error: null })
      assert.equal(sent.lookups(), 1)
    } else {
      assert.deepEqual(await sweepWriteReceipts(f.pool, readback), { retired: 0, readBack: 1, outcomes: { failed: 1 } })
      assert.deepEqual(await sent.status(sent.receipt.id), { status: 'failed', error: 'writeUnconfirmed' })
      assert.equal(sent.lookups(), 0, 'the provider is never read with an authority the owner no longer holds')
      assert.deepEqual(await sweepWriteReceipts(f.pool, readback), { retired: 0, readBack: 0, outcomes: {} })
    }
    assert.deepEqual(await effects(f.origin), { posts: 1, effects: 1 })
  } finally { await f.close() }
})
