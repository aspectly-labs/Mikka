import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'

// 停止 the moment a send is accepted (decision 2026-11-22-1600): input no turn has taken is ended under the chat's lock.
// Database regressions execute only against a disposable loopback Postgres 17; REQUIRE_DB=1 makes a missing one fail.
let databaseUrl: string | undefined
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  if (isE2eTarget(target.href) && process.env.MIKKA_DATABASE_URL === target.href
    && process.env.DATABASE_URL === target.href) databaseUrl = target.href
} catch { /* no eligible disposable database */ }
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching loopback *_e2e database')
const dbTest = databaseUrl ? test : test.skip

async function fixture() {
  const [{ createRequestDatabaseScope, db, pool }, schema, { sql }, { recordPersonalSubmission }] = await Promise.all([
    import('../db'), import('../db/schema'), import('drizzle-orm'), import('../coordinator-submission'),
  ])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const person = async (id: string) => {
    await db.execute(sql`insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values (${id},'Stop fixture',${`${id}@example.invalid`},true,now(),now())`)
    const workspaceId = await seedFixtureWorkspace(pool, id)
    const botId = randomUUID()
    await db.insert(schema.bots).values({ id: botId, ownerId: id, workspaceId, name: 'Stop fixture' })
    return { id, botId, workspaceId }
  }
  const send = async (owner: string, botId: string, text: string) => (await recordPersonalSubmission(db, owner, text, { botId, submissionId: randomUUID() })).eventId
  const event = async (id: string) => (await db.execute(sql`select "deliveredAt",payload from coordinator_events where id=${id}::uuid`)).rows[0] as { deliveredAt: Date | null; payload: Record<string, unknown> }
  const messages = async (owner: string, botId: string) => (await db.execute(sql`select message from coordinator_messages where "userId"=${owner} and "botId"=${botId}::uuid order by position`)).rows.map(row => row.message as Record<string, unknown>)
  return { scope, db, sql, person, send, event, messages }
}

dbTest('Stop ends accepted input no turn has taken: the message stays, a stopped reply under it, and no turn ever starts', async t => {
  const f = await fixture()
  t.after(() => f.scope.close())
  await f.scope.run(async () => {
    const [{ stopBeforeTurn }, store, { markEventAccepted }] = await Promise.all([import('./stop-before-turn'), import('@/tests/support/legacy-coordinator-store'), import('../eve/submission')])
    const owner = await f.person(`stop-before-turn-${randomUUID()}`)
    const eventId = await f.send(owner.id, owner.botId, 'Check the dark theme too')
    assert.equal((await store.chatView(owner.id, 200, owner.botId)).working, true, 'accepted input reads as working, so the chat offers Stop')
    assert.deepEqual(await stopBeforeTurn(owner.id, owner.botId), { ended: 1, onTheirWay: 0, turnRunning: false })
    const stored = await f.event(eventId)
    assert.ok(stored.deliveredAt, 'the outbox never delivers it to a turn')
    assert.equal(stored.payload.stoppedBeforeTurn, true)
    const view = await store.chatView(owner.id, 200, owner.botId)
    assert.equal(view.working, false)
    assert.deepEqual(view.items.map(item => [item.from, item.text, Boolean(item.stopped)]), [['person', 'Check the dark theme too', false], ['coordinator', '', true]])
    assert.equal((await store.botChats(owner.id))[owner.botId].working, false, 'the sidebar stops spinning with it')
    // eve accepting it afterwards (the web send raced the stop) projects nothing more and asks its caller to stop the turn.
    assert.equal(await markEventAccepted({ ownerId: owner.id, botId: owner.botId, workspaceId: owner.workspaceId, surface: 'web' }, eventId), true)
    assert.equal((await f.messages(owner.id, owner.botId)).length, 2)
    assert.deepEqual(await stopBeforeTurn(owner.id, owner.botId), { ended: 0, onTheirWay: 0, turnRunning: false }, 'a second Stop finds nothing')
  })
})

dbTest('input already on its way to eve is not ended twice: its acceptance stops the turn it starts', async t => {
  const f = await fixture()
  t.after(() => f.scope.close())
  await f.scope.run(async () => {
    const [{ stopBeforeTurn }, { markEventAccepted }] = await Promise.all([import('./stop-before-turn'), import('../eve/submission')])
    const owner = await f.person(`stop-in-flight-${randomUUID()}`)
    const eventId = await f.send(owner.id, owner.botId, 'Run the suite')
    // The outbox claimed it under the same lock (deliverEveEvent).
    await f.db.execute(f.sql`update coordinator_events set "wakeLeaseUntil"=now()+interval '2 minutes' where id=${eventId}::uuid`)
    assert.deepEqual(await stopBeforeTurn(owner.id, owner.botId), { ended: 0, onTheirWay: 1, turnRunning: false })
    assert.equal((await f.event(eventId)).deliveredAt, null, 'the claimed delivery still records it')
    assert.equal(await markEventAccepted({ ownerId: owner.id, botId: owner.botId, workspaceId: owner.workspaceId, surface: 'web' }, eventId), true, 'its acceptance asks to stop the turn')
    const [message] = await f.messages(owner.id, owner.botId)
    assert.equal(message.mikkaEveAccepted, true)
    // Input nobody stopped is accepted as before.
    const next = await f.send(owner.id, owner.botId, 'Then deploy')
    assert.equal(await markEventAccepted({ ownerId: owner.id, botId: owner.botId, workspaceId: owner.workspaceId, surface: 'web' }, next), false)
  })
})

dbTest('Stop is owner-only: another person, a workspace member, another workspace and another bot keep their input', async t => {
  const f = await fixture()
  t.after(() => f.scope.close())
  await f.scope.run(async () => {
    const [{ stopBeforeTurn }, { stopChatTurn }, schema] = await Promise.all([import('./stop-before-turn'), import('./stop-turn'), import('../db/schema')])
    const owner = await f.person(`stop-owner-${randomUUID()}`)
    const stranger = await f.person(`stop-stranger-${randomUUID()}`)
    const eventId = await f.send(owner.id, owner.botId, 'Owner request')
    // A member of the owner's workspace with a bot of their own there.
    const member = `stop-member-${randomUUID()}`
    await f.db.execute(f.sql`insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values (${member},'Member',${`${member}@example.invalid`},true,now(),now())`)
    const memberBot = randomUUID()
    await f.db.insert(schema.bots).values({ id: memberBot, ownerId: member, workspaceId: owner.workspaceId, name: 'Member bot' })
    // The owner's other bot, with input of its own.
    const otherBot = randomUUID()
    await f.db.insert(schema.bots).values({ id: otherBot, ownerId: owner.id, workspaceId: owner.workspaceId, name: 'Other bot' })
    const otherEvent = await f.send(owner.id, otherBot, 'Other bot request')
    const none = { ended: 0, onTheirWay: 0, turnRunning: false }
    assert.deepEqual(await stopBeforeTurn(stranger.id, owner.botId), none, 'another person naming the bot')
    assert.deepEqual(await stopBeforeTurn(member, owner.botId), none, 'a member of the same workspace')
    assert.deepEqual(await stopBeforeTurn(member, memberBot), none, 'a member stopping their own bot')
    assert.deepEqual(await stopBeforeTurn(stranger.id, stranger.botId), none, 'another workspace')
    assert.equal(await stopChatTurn(stranger.id, owner.botId), false)
    assert.equal((await f.event(eventId)).deliveredAt, null, 'the owner\'s input still waits for its turn')
    assert.deepEqual(await stopBeforeTurn(owner.id, owner.botId), { ended: 1, onTheirWay: 0, turnRunning: false })
    assert.equal((await f.event(otherEvent)).deliveredAt, null, 'a Stop in one chat leaves the owner\'s other bot alone')
  })
})

dbTest('a turn that holds the lease with no stream on the page is the one Stop cancels: the lease holder\'s session, the owner\'s only', async t => {
  const f = await fixture()
  t.after(() => f.scope.close())
  await f.scope.run(async () => {
    const [{ stopBeforeTurn }, { runningTurnSession }] = await Promise.all([import('./stop-before-turn'), import('./stop-turn')])
    const owner = await f.person(`stop-leased-${randomUUID()}`)
    const stranger = await f.person(`stop-leased-other-${randomUUID()}`)
    const older = `wrun_${randomUUID()}`, holder = `wrun_${randomUUID()}`, newer = `wrun_${randomUUID()}`
    for (const [session, at] of [[older, '2026-11-20T10:00:00Z'], [holder, '2026-11-20T11:00:00Z'], [newer, '2026-11-20T12:00:00Z']]) {
      await f.db.execute(f.sql`insert into eve_sessions(session_id,owner_id,bot_id,workspace_id,surface,created_at) values (${session},${owner.id},${owner.botId}::uuid,${owner.workspaceId}::uuid,'web',${at}::timestamptz)`)
    }
    await f.db.execute(f.sql`insert into coordinator_sessions("userId","botId","leaseHolder","leaseUntil") values (${owner.id},${owner.botId}::uuid,${holder},now()+interval '1 hour')`)
    assert.deepEqual(await stopBeforeTurn(owner.id, owner.botId), { ended: 0, onTheirWay: 0, turnRunning: true }, 'the leased turn counts as running')
    assert.equal((await runningTurnSession(owner.id, owner.botId))?.session_id, holder, 'Stop cancels the lease holder, not the newest session')
    assert.equal(await runningTurnSession(stranger.id, owner.botId), null, 'another person finds no session of this chat')
    assert.deepEqual(await stopBeforeTurn(stranger.id, owner.botId), { ended: 0, onTheirWay: 0, turnRunning: false })
  })
})
