import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test, { mock } from 'node:test'
import pg from 'pg'
import { validateTarget } from '../../scripts/run-db-tests.mjs'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'
import { makeSnapshot, digest } from '../agent-kit/definition'
import { DEFAULT_AGENT_DEFINITION } from '../agent-kit/builtin'
import type { WriteProvider } from './write-contract'

// Remembered approvals (decision 2026-11-27-1500-remembered-approvals) against
// real PostgreSQL: a rule answers only its owner's ask, from its own Bot, for
// the exact target the card showed; a decline's words reach the Coordinator.
const url = process.env.E2E_DATABASE_URL
if (url) validateTarget(process.env)

test('remembered approvals: owner and Bot isolation, exact match, revoke, and the decline note', { skip: !url, timeout: 240_000 }, async t => {
  const queued: (() => Promise<void>)[] = []
  const server = await import('@/lib/server-runtime/server')
  const scheduler = mock.module('@/lib/server-runtime/server', { namedExports: { ...server, after: (work: () => Promise<void>) => { queued.push(work) } } })
  const wake = mock.module(new URL('../coordinator/wake.ts', import.meta.url).href, { namedExports: { wakeCoordinator: async () => undefined } })
  const sent: { action: string; input: unknown; accountId?: string }[] = []
  let composio: ReturnType<typeof mock.module> | undefined
  const admin = new pg.Pool({ connectionString: url, max: 1 })
  const name = `approval_rules_${randomUUID().replaceAll('-', '')}_e2e`
  const globals = globalThis as unknown as { mikkaPool?: pg.Pool; workspacePool?: pg.Pool }
  const previous = { app: globals.mikkaPool, workspace: globals.workspacePool }
  let database: pg.Pool | undefined
  try {
    await createTestDatabase(admin, name, 'template0')
    const target = new URL(url!); target.pathname = `/${name}`
    database = new pg.Pool({ connectionString: target.toString(), max: 6 })
    const directory = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(directory)).filter(file => file.endsWith('.sql')))) await database.query(await readFile(new URL(file, directory), 'utf8'))
    globals.mikkaPool = database; globals.workspacePool = database
    const realComposio = await import('../composio')
    // The real dispatch gate runs; only the provider call is replaced.
    composio = mock.module(new URL('../composio.ts', import.meta.url).href, { namedExports: { ...realComposio,
      resolveActionAccount: async () => ({ accountId: 'ca_mail', accounts: [] }),
      runComposioAction: async (_userId: string, action: string, input: unknown, accountId?: string, gate?: (account: string, tool: { version?: string }) => Promise<{ error: string } | null>) => {
        const stopped = gate ? await gate(accountId ?? 'ca_mail', { version: 'v1' }) : null
        if (stopped) return stopped
        sent.push({ action, input, accountId }); return { data: { id: `sent-${sent.length}` } }
      },
    } })
    const db = database
    const { rememberApproval, hasRememberedApproval, listApprovalRules, revokeApprovalRule } = await import('./approval-rule-store')
    const { writeAccountAction, listPendingActions } = await import('../pending-action-store')
    const { decidePendingAction } = await import('../pending-actions')

    const alice = `alice-${randomUUID()}`, bob = `bob-${randomUUID()}`
    const bots: Record<string, string> = {}, homes: Record<string, string> = {}
    for (const userId of [alice, bob]) {
      const workspaceId = randomUUID(); homes[userId] = workspaceId
      await db.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Rule fixture\',$2,true,now(),now())', [userId, `${userId}@example.invalid`])
      await db.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,\'Rule fixture\',\'personal\')', [workspaceId, userId])
      await db.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,\'Rule fixture\',$3,\'admin\',\'active\')', [workspaceId, userId, `${userId}@example.invalid`])
      for (const key of ['one', 'two']) {
        const botId = randomUUID(); bots[`${userId}:${key}`] = botId
        await db.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,$4)', [botId, userId, workspaceId, `Rule fixture ${key}`])
      }
    }
    const aliceBot = bots[`${alice}:one`], aliceOther = bots[`${alice}:two`], bobBot = bots[`${bob}:one`]
    const ask = async () => 'ask' as const
    const email = (to: string[], subject = 'Weekly notes') => ({ to, subject, body: 'Attached.' })
    const pending = async (userId: string) => Number((await db.query(`SELECT count(*) FROM pending_actions WHERE "userId"=$1 AND status='pending'`, [userId])).rows[0].count)

    await t.test('the store keeps each rule to its owner and Bot and matches only the exact target', async () => {
      const match = { action: 'send_email' as const, account: 'ca_store', recipients: ['kim@acme.dev'] }
      assert.equal(await rememberApproval(db, { ownerId: alice, botId: aliceBot, match }), true)
      assert.equal(await rememberApproval(db, { ownerId: alice, botId: aliceBot, match }), true, 'a second click keeps one rule')
      assert.equal(Number((await db.query('SELECT count(*) FROM approval_rules WHERE "ownerId"=$1', [alice])).rows[0].count), 1)
      assert.equal(await hasRememberedApproval(db, { ownerId: alice, botId: aliceBot, match }), true)
      assert.equal(await hasRememberedApproval(db, { ownerId: alice, botId: aliceBot, match: { ...match, recipients: ['kim@acme.dev', 'lee@acme.dev'] } }), false, 'another recipient set')
      assert.equal(await hasRememberedApproval(db, { ownerId: alice, botId: aliceOther, match }), false, 'another Bot')
      assert.equal(await hasRememberedApproval(db, { ownerId: bob, botId: aliceBot, match }), false, 'another person')
      assert.equal(await hasRememberedApproval(db, { ownerId: alice, botId: null, match }), false, 'no Bot, no rule')
      assert.equal(await rememberApproval(db, { ownerId: alice, botId: null, match }), false)
      const [rule] = await listApprovalRules(db, alice)
      assert.deepEqual({ ...rule, createdAt: undefined, lastUsedAt: undefined, id: undefined }, { id: undefined, botId: aliceBot, action: 'send_email', match, createdAt: undefined, lastUsedAt: undefined, active: true })
      assert.ok(rule.lastUsedAt, 'a use is recorded')
      assert.deepEqual(await listApprovalRules(db, bob), [])
      assert.equal(await revokeApprovalRule(db, bob, rule.id), false, 'another person cannot revoke it')
      assert.equal(await revokeApprovalRule(db, alice, rule.id), true)
      assert.equal(await hasRememberedApproval(db, { ownerId: alice, botId: aliceBot, match }), false)
      assert.equal(await revokeApprovalRule(db, alice, rule.id), false)
    })

    await t.test('「始终同意」 on a card answers the next ask for the same recipients from the same Bot only', async () => {
      const first = await writeAccountAction(alice, 'send_email', email(['kim@acme.dev']), undefined, aliceBot, ask)
      assert.equal((first as { status: string }).status, 'awaiting_approval')
      assert.equal(sent.length, 0)
      const id = (first as { actionId: string }).actionId
      const listed = (await listPendingActions(alice)).find(item => item.id === id)
      assert.equal(listed?.rememberable, true)
      await assert.rejects(decidePendingAction(bob, id, true, { remember: true }), /pendingActionUnavailable/)
      assert.equal(Number((await db.query('SELECT count(*) FROM approval_rules WHERE "ownerId"=$1', [bob])).rows[0].count), 0)
      const decided = await decidePendingAction(alice, id, true, { remember: true })
      assert.deepEqual(decided, { status: 'done', error: null, remembered: true })
      assert.equal(sent.length, 1)
      const rules = await listApprovalRules(db, alice)
      assert.equal(rules.length, 1); assert.equal(rules[0].botId, aliceBot)
      assert.deepEqual(rules[0].match, { action: 'send_email', account: 'ca_mail', recipients: ['kim@acme.dev'] })

      // Same Bot, same account, same recipient, other text: runs without a card.
      const again = await writeAccountAction(alice, 'send_email', email(['KIM@acme.dev'], 'Another subject'), undefined, aliceBot, ask)
      assert.equal((again as { status: string }).status, 'done')
      assert.equal(sent.length, 2); assert.equal(await pending(alice), 0)
      // A different recipient, another Bot, or another person still ask.
      for (const [owner, botId, to] of [[alice, aliceBot, ['kim@acme.dev', 'boss@acme.dev']], [alice, aliceOther, ['kim@acme.dev']], [bob, bobBot, ['kim@acme.dev']]] as const) {
        const result = await writeAccountAction(owner, 'send_email', email([...to]), undefined, botId, ask)
        assert.equal((result as { status: string }).status, 'awaiting_approval', `${owner === alice ? 'alice' : 'bob'} ${botId === aliceBot ? 'same' : 'other'} bot ${to.join(',')}`)
      }
      assert.equal(sent.length, 2)
      // A deny is never answered by a rule.
      const denied = await writeAccountAction(alice, 'send_email', email(['kim@acme.dev']), undefined, aliceBot, async () => 'deny' as const)
      assert.deepEqual(denied, { error: 'integrationActionDenied' })
      // Revoked: the same call asks again.
      assert.equal(await revokeApprovalRule(db, alice, rules[0].id), true)
      const revoked = await writeAccountAction(alice, 'send_email', email(['kim@acme.dev']), undefined, aliceBot, ask)
      assert.equal((revoked as { status: string }).status, 'awaiting_approval')
      assert.equal(sent.length, 2)
    })

    await t.test('a decline carries the person\'s words to the Agent and remembers nothing', async () => {
      const card = await writeAccountAction(alice, 'send_email', email(['dana@acme.dev']), undefined, aliceBot, ask)
      const id = (card as { actionId: string }).actionId
      const token = 'ghp_' + 'b'.repeat(36)
      const result = await decidePendingAction(alice, id, false, { remember: true, note: `  Send it to the team list instead. Use ${token}  ` })
      assert.deepEqual(result, { status: 'declined', error: null, remembered: false })
      const event = await db.query('SELECT payload,"botId" FROM coordinator_events WHERE "dedupeKey"=$1', [`action_decided:${id}`])
      assert.equal(event.rows[0].payload.status, 'declined')
      assert.match(event.rows[0].payload.note, /^Send it to the team list instead\. Use /)
      assert.ok(!JSON.stringify(event.rows[0].payload).includes(token), 'a pasted credential is masked before it is stored')
      assert.equal(event.rows[0].botId, aliceBot)
      assert.equal(await hasRememberedApproval(db, { ownerId: alice, botId: aliceBot, match: { action: 'send_email', account: 'ca_mail', recipients: ['dana@acme.dev'] } }), false)
      // An older caller (no options) still works and sends no note.
      const plain = await writeAccountAction(alice, 'send_email', email(['erin@acme.dev']), undefined, aliceBot, ask)
      const plainId = (plain as { actionId: string }).actionId
      assert.deepEqual(await decidePendingAction(alice, plainId, false), { status: 'declined', error: null, remembered: false })
      assert.equal((await db.query('SELECT payload FROM coordinator_events WHERE "dedupeKey"=$1', [`action_decided:${plainId}`])).rows[0].payload.note, undefined)
    })

    await t.test('a card without a Bot is never rememberable', async () => {
      const card = await writeAccountAction(alice, 'send_email', email(['fay@acme.dev']), undefined, null, ask)
      const id = (card as { actionId: string }).actionId
      assert.equal((await listPendingActions(alice)).find(item => item.id === id)?.rememberable, undefined)
      assert.deepEqual(await decidePendingAction(alice, id, true, { remember: true }), { status: 'done', error: null, remembered: false })
    })

    await t.test('the Coordinator\'s own path (no review) sends at once: there is no ask for a rule to answer', async () => {
      // workflows/coordinator/steps.ts accountWrite calls writeAccountAction with no review.
      const before = sent.length, cards = await pending(alice)
      const direct = await writeAccountAction(alice, 'send_email', email(['hal@acme.dev']), undefined, aliceBot)
      assert.equal((direct as { status: string }).status, 'done')
      assert.equal(sent.length, before + 1); assert.equal(await pending(alice), cards)
    })

    await t.test('remembering a card that is no longer waiting is refused', async () => {
      const card = await writeAccountAction(alice, 'send_email', email(['ivy@acme.dev']), undefined, aliceBot, ask)
      const id = (card as { actionId: string }).actionId
      assert.equal((await decidePendingAction(alice, id, true)).status, 'done')
      await assert.rejects(decidePendingAction(alice, id, true, { remember: true }), /pendingActionUnavailable/)
      assert.equal(await hasRememberedApproval(db, { ownerId: alice, botId: aliceBot, match: { action: 'send_email', account: 'ca_mail', recipients: ['ivy@acme.dev'] } }), false)
    })

    await t.test('a failed rule save never strands the card: the outcome is recorded first', async () => {
      const card = await writeAccountAction(alice, 'send_email', email(['jo@acme.dev']), undefined, aliceBot, ask)
      const id = (card as { actionId: string }).actionId
      await db.query(`CREATE FUNCTION reject_approval_rule() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW."sourceActionId"='${id}' THEN RAISE EXCEPTION 'fixture rule store down'; END IF; RETURN NEW; END $$`)
      await db.query('CREATE TRIGGER reject_approval_rule BEFORE INSERT ON approval_rules FOR EACH ROW EXECUTE FUNCTION reject_approval_rule()')
      try {
        assert.deepEqual(await decidePendingAction(alice, id, true, { remember: true }), { status: 'done', error: null, remembered: false })
        assert.equal((await db.query('SELECT status FROM pending_actions WHERE id=$1', [id])).rows[0].status, 'done')
        assert.equal((await db.query('SELECT payload FROM coordinator_events WHERE "dedupeKey"=$1', [`action_decided:${id}`])).rows[0].payload.status, 'done')
      } finally {
        await db.query('DROP TRIGGER IF EXISTS reject_approval_rule ON approval_rules')
        await db.query('DROP FUNCTION IF EXISTS reject_approval_rule()')
      }
    })

    await t.test('a rule stops answering once its Bot is re-instructed, redefined or paused', async () => {
      const match = { action: 'send_email' as const, account: 'ca_bind', recipients: ['kai@acme.dev'] }
      const answers = () => hasRememberedApproval(db, { ownerId: alice, botId: aliceBot, match })
      const active = async () => (await listApprovalRules(db, alice)).find(rule => rule.match.action === 'send_email' && (rule.match as { account: string }).account === 'ca_bind')?.active
      assert.equal(await rememberApproval(db, { ownerId: alice, botId: aliceBot, match }), true)
      assert.equal(await answers(), true)
      await db.query('UPDATE bots SET instructions=$2 WHERE id=$1', [aliceBot, 'Always cc the team.'])
      assert.equal(await answers(), false, 'new instructions'); assert.equal(await active(), false)
      await db.query('UPDATE bots SET instructions=\'\' WHERE id=$1', [aliceBot])
      assert.equal(await answers(), true, 'the same Bot again')
      // A new Agent definition version for this person and Bot.
      await db.query('INSERT INTO agent_kit_heads(owner_id,bot_key,bot_id,workspace_id) VALUES($1,$2,$3,$4)', [alice, aliceBot, aliceBot, homes[alice]])
      const version = randomUUID()
      await db.query('INSERT INTO agent_kit_versions(id,owner_id,bot_key,version,definition,digest,source,request_key) VALUES($1,$2,$3,1,\'{}\'::jsonb,$4,\'user\',$5)', [version, alice, aliceBot, 'a'.repeat(64), randomUUID()])
      await db.query('UPDATE agent_kit_heads SET active_version=$1 WHERE owner_id=$2 AND bot_key=$3', [version, alice, aliceBot])
      assert.equal(await answers(), false, 'a new definition')
      assert.equal(await rememberApproval(db, { ownerId: alice, botId: aliceBot, match }), true, 'answering again binds the new definition')
      assert.equal(await answers(), true)
      await db.query('UPDATE bots SET "archivedAt"=now() WHERE id=$1', [aliceBot])
      assert.equal(await answers(), false, 'a paused Bot')
      assert.equal(await rememberApproval(db, { ownerId: alice, botId: aliceBot, match }), false, 'no rule for a paused Bot')
      await db.query('UPDATE bots SET "archivedAt"=NULL WHERE id=$1', [aliceBot])
      assert.equal(await answers(), true)
    })

    await t.test('handing a Bot over or leaving the workspace deletes the rules', async () => {
      const { transferBots, releaseDepartingMember } = await import('../workspace-admin/members')
      const { db: drizzle } = await import('../db')
      const mail = (to: string) => ({ action: 'send_email' as const, account: 'ca_move', recipients: [to] })
      assert.equal(await rememberApproval(db, { ownerId: alice, botId: aliceBot, match: mail('lu@acme.dev') }), true)
      assert.equal(await rememberApproval(db, { ownerId: bob, botId: aliceBot, match: mail('lu@acme.dev') }), true, 'a member using the Bot')
      const kept = randomUUID()
      await db.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,\'Rule fixture kept\')', [kept, alice, homes[alice]])
      assert.equal(await rememberApproval(db, { ownerId: alice, botId: kept, match: mail('mo@acme.dev') }), true)
      await drizzle.transaction(tx => transferBots(tx, homes[alice], alice, bob, [aliceBot]))
      assert.equal(Number((await db.query('SELECT count(*) FROM approval_rules WHERE "botId"=$1', [aliceBot])).rows[0].count), 0, 'every rule on the handed-over Bot')
      assert.equal(await hasRememberedApproval(db, { ownerId: alice, botId: kept, match: mail('mo@acme.dev') }), true, 'other Bots keep theirs')
      // Bob, a member of Alice's workspace, leaves it: his rules there go; his rules elsewhere stay.
      assert.equal(await rememberApproval(db, { ownerId: bob, botId: kept, match: mail('ned@acme.dev') }), true)
      assert.equal(await rememberApproval(db, { ownerId: bob, botId: bobBot, match: mail('ned@acme.dev') }), true)
      await releaseDepartingMember(homes[alice], bob)
      assert.equal(await hasRememberedApproval(db, { ownerId: bob, botId: kept, match: mail('ned@acme.dev') }), false)
      assert.equal(Number((await db.query('SELECT count(*) FROM approval_rules WHERE "ownerId"=$1 AND "workspaceId"=$2', [bob, homes[alice]])).rows[0].count), 0)
      assert.equal(await hasRememberedApproval(db, { ownerId: bob, botId: bobBot, match: mail('ned@acme.dev') }), true)
      assert.equal(await hasRememberedApproval(db, { ownerId: alice, botId: kept, match: mail('mo@acme.dev') }), true)
    })

    await t.test('deleting the Bot removes its rules', async () => {
      await rememberApproval(db, { ownerId: alice, botId: aliceOther, match: { action: 'send_email', account: 'ca_mail', recipients: ['gus@acme.dev'] } })
      await db.query('DELETE FROM bots WHERE id=$1', [aliceOther])
      assert.equal((await listApprovalRules(db, alice)).some(rule => rule.botId === aliceOther), false)
    })
    await Promise.all(queued.splice(0).map(work => work().catch(() => undefined)))
  } finally {
    queued.splice(0); composio?.restore(); wake.restore(); scheduler.restore()
    globals.mikkaPool = previous.app; globals.workspacePool = previous.workspace
    await dropTestDatabase(admin, name, database)
    await admin.end()
  }
})

test('remembered approved writes: one Bot, one page; another page or Bot still asks; a decline note reaches the notice', { skip: !url, timeout: 60_000 }, async () => {
  const { createApprovedWrites } = await import('./approved-writes')
  const { approvedWriteHandler } = await import('./write-http')
  const schema = 'approval_rule_writes_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Pool({ connectionString: url, max: 1 })
  let pool: pg.Pool | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const scoped = new URL(url!); scoped.searchParams.set('options', `-c search_path=${schema},pg_catalog`)
    pool = new pg.Pool({ connectionString: scoped.href, max: 4 })
    const db = pool
    // The tables the write path reads, as write-policy-chain.db.test.ts builds them, plus the two the rule table references.
    await db.query(`create table "session" (id text primary key, "userId" text not null, "expiresAt" timestamptz not null);
      create table agent_kit_heads (owner_id text, bot_key text, bot_id uuid, workspace_id uuid, active_version uuid, primary key (owner_id,bot_key));
      create table agent_kit_versions (owner_id text, bot_key text, id uuid, definition jsonb, digest text);
      create table agent_kit_executions (owner_id text, bot_key text, id uuid, status text, snapshot jsonb, version_id uuid);
      create table "user" (id text primary key);
      create table bots (id uuid primary key, "ownerId" text, "workspaceId" uuid not null, instructions text not null default '', "archivedAt" timestamptz);
      create table coordinator_bots ("botId" uuid primary key);
      create function mikka_account_guard_insert() returns trigger language plpgsql as $$ begin return new; end $$;`)
    for (const file of ['20261025043000_pending_actions.sql', '20261028143920_operation_ledger.sql', '20261028143921_approved_write_binding.sql', '20261027164515_workspace_computer_policy.sql', '20261029010447_workspace_computer_policy_allow.sql', '20261029043646_agent_external_write_policy.sql', '20261029043647_workspace_external_write_policy.sql', '20261030204751_workspace_computer_policy_default_allow.sql', '20261127145325_approval_rules.sql']) {
      await db.query(await readFile(new URL('../../drizzle/' + file, import.meta.url), 'utf8'))
    }
    const owner = 'fixture-owner', action = 'append_notion_paragraph' as const, actor = { userId: owner, sessionId: 'fixture-session' }
    const definition = { ...DEFAULT_AGENT_DEFINITION, tools: [action] }
    await db.query('insert into "user" values ($1)', [owner])
    await db.query('insert into "session" values($1,$2,now()+interval \'1 hour\')', [actor.sessionId, owner])
    const membership = async (_tx: unknown, signal: AbortSignal) => ({ signal, workspaceClient: { query: async () => ({ rows: [{ role: 'admin' }] }) } as never, check: async () => {}, close: async () => {} })
    const runs: Record<string, { ownerId: string; botId: string; workspaceId: string; runId: string }> = {}
    for (const key of ['one', 'two']) {
      const botId = randomUUID(), workspaceId = randomUUID(), runId = randomUUID(), revision = randomUUID()
      await db.query('insert into bots(id,"ownerId","workspaceId") values ($1,$2,$3)', [botId, owner, workspaceId])
      await db.query('insert into agent_kit_heads(owner_id,bot_key,bot_id,workspace_id,active_version) values($1,$2,$3,$4,$5)', [owner, botId, botId, workspaceId, revision])
      await db.query('insert into agent_kit_versions values($1,$2,$3,$4,$5)', [owner, botId, revision, definition, digest(definition)])
      await db.query('insert into agent_kit_executions values($1,$2,$3,$4,$5,$6)', [owner, botId, runId, 'running', makeSnapshot(revision, 1, definition, 'host', { harness: 'ai_sdk', model: 'openai/gpt-6-luna' }), revision])
      runs[key] = { ownerId: owner, botId, workspaceId, runId }
    }
    let writes = 0
    const provider: WriteProvider = { name: 'synthetic', prepare: async () => ({ accountId: 'account', version: 'v1' }), execute: async ({ beforeSend }) => { await beforeSend(); writes++; return { providerObjectId: `page-${writes}`, evidenceDigest: 'a'.repeat(64) } }, lookup: async () => null }
    const notices: { status: string; note: string | null | undefined }[] = []
    const asking = (key: 'one' | 'two') => createApprovedWrites(db, provider, action, { modelRun: runs[key], guard: membership, guardForRun: () => membership, nativeWriteReview: async () => 'ask' })
    const handler = approvedWriteHandler({ api: { getSession: async () => ({ user: { id: owner }, session: { id: actor.sessionId } }) } }, (name, context) => createApprovedWrites(db, provider, name, { ...context, guardForRun: () => membership }, async (_p, result, note) => { notices.push({ status: result.status, note }) }))
    const decide = async (id: string, body: Record<string, unknown>) => {
      const response = await handler(new Request('https://fixture.invalid/api/approved-writes', { method: 'POST', headers: { origin: 'https://fixture.invalid', cookie: 'fixture=1' }, body: JSON.stringify({ op: 'decide', action, id, ...body }) }))
      assert.equal(response.status, 200); return response.json()
    }
    const page = randomUUID(), otherPage = randomUUID()

    const first = await asking('one').proposeFromRun({ page_id: page, text: 'first' }, randomUUID())
    assert.equal(first.status, 'awaiting_approval'); assert.equal(writes, 0)
    assert.deepEqual(await decide(first.actionId, { approve: true, remember: true }), { status: 'done', error: null, outcome: { id: 'page-1' }, remembered: true })
    assert.equal(writes, 1)
    const [rule] = (await db.query('select "botId",match from approval_rules where "ownerId"=$1', [owner])).rows
    assert.equal(rule.botId, runs.one.botId)
    assert.equal(rule.match.action, action); assert.equal(rule.match.account, 'account')
    assert.ok(!JSON.stringify(rule.match).includes('first'), 'the rule never stores the text')

    const same = await asking('one').proposeFromRun({ page_id: page, text: 'second' }, randomUUID())
    assert.equal(same.status, 'done'); assert.equal(writes, 2)
    const elsewhere = await asking('one').proposeFromRun({ page_id: otherPage, text: 'third' }, randomUUID())
    assert.equal(elsewhere.status, 'awaiting_approval', 'another page is another target')
    const otherBot = await asking('two').proposeFromRun({ page_id: page, text: 'fourth' }, randomUUID())
    assert.equal(otherBot.status, 'awaiting_approval', 'another Bot (and workspace) is another rule')
    assert.equal(writes, 2)

    assert.deepEqual(await decide(elsewhere.actionId, { approve: false, note: 'Append to the release page instead' }), { status: 'declined', error: null, remembered: false })
    assert.deepEqual(notices.at(-1), { status: 'declined', note: 'Append to the release page instead' })
    assert.deepEqual(await decide(otherBot.actionId, { approve: false }), { status: 'declined', error: null, remembered: false })
    assert.deepEqual(notices.at(-1), { status: 'declined', note: null })
    assert.equal(Number((await db.query('select count(*) from approval_rules')).rows[0].count), 1)

    // A decided write cannot be remembered afterwards.
    const decidedAgain = await handler(new Request('https://fixture.invalid/api/approved-writes', { method: 'POST', headers: { origin: 'https://fixture.invalid', cookie: 'fixture=1' }, body: JSON.stringify({ op: 'decide', action, id: first.actionId, approve: true, remember: true }) }))
    assert.equal(decidedAgain.status, 409)
    assert.deepEqual(await decidedAgain.json(), { error: 'pendingActionUnavailable' })

    // A failed rule save rolls back to its savepoint: the approval and its write stand.
    const thirdPage = randomUUID()
    const failing = await asking('one').proposeFromRun({ page_id: thirdPage, text: 'fifth' }, randomUUID())
    assert.equal(failing.status, 'awaiting_approval')
    await db.query(`create function reject_rule() returns trigger language plpgsql as $$ begin raise exception 'fixture rule store down'; end $$`)
    await db.query('create trigger reject_rule before insert on approval_rules for each row execute function reject_rule()')
    try {
      const saved = await decide(failing.actionId, { approve: true, remember: true })
      assert.equal(saved.status, 'done'); assert.equal(saved.remembered, false); assert.equal(writes, 3)
    } finally { await db.query('drop trigger reject_rule on approval_rules'); await db.query('drop function reject_rule()') }

    // A new Agent definition for the Bot: the rule no longer answers.
    const redefined = randomUUID()
    await db.query('update agent_kit_heads set active_version=$1 where owner_id=$2 and bot_key=$3', [redefined, owner, runs.one.botId])
    await db.query('insert into agent_kit_versions values($1,$2,$3,$4,$5)', [owner, runs.one.botId, redefined, definition, digest(definition)])
    const afterChange = await asking('one').proposeFromRun({ page_id: page, text: 'sixth' }, randomUUID())
    assert.equal(afterChange.status, 'awaiting_approval', 'a redefined Bot asks again')
    assert.equal(writes, 3)
  } finally {
    await pool?.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
