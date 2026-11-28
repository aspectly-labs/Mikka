import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { seedCoordinator } from '../../tests/support/coordinator-bot'
import type { EveScope } from '../eve/scope'

const target = process.env.E2E_DATABASE_URL
const eligible = target && isE2eTarget(target) && process.env.MIKKA_DATABASE_URL === target && process.env.DATABASE_URL === target
if (!eligible && process.env.REQUIRE_DB === '1') throw new Error('Rule regression requires matching isolated loopback *_e2e databases')

mock.module(new URL('../default-model.ts', import.meta.url).href, { namedExports: {
  defaultModelTarget: async () => ({ kind: 'hosted' }), defaultModelAvailable: async () => true,
} })
let refuseDelivery = true
const handedOff: string[] = []
mock.module(new URL('../eve/server-client.ts', import.meta.url).href, { namedExports: {
  sendEveEvent: async (scope: EveScope, eventId: string) => {
    const { deliverEveEvent } = await import('../eve/submission')
    const session = { send: async (_message: unknown, options: { idempotencyKey: string; turnPolicy: string; auth: { attributes?: Record<string, unknown> } }) => {
      assert.equal(options.idempotencyKey, 'mikka-event:' + eventId)
      assert.equal(options.turnPolicy, 'queue')
      assert.equal(options.auth.attributes?.sourceEventId, eventId)
      handedOff.push(eventId)
      if (refuseDelivery) throw new Error('synthetic Eve boundary failure')
      return { sessionId: 'fixture-session', deliveryId: 'fixture-delivery' }
    } } as unknown as Parameters<typeof deliverEveEvent>[1]
    return deliverEveEvent(scope, session, eventId)
  },
} })

test('rule completion persists through the real store and wakes Eve, retaining retryability on a delivery error', { skip: !eligible }, async t => {
  const [{ createRequestDatabaseScope, db, pool }, schema, store, wake, { deliverRunCompletion }, { eq, sql }] = await Promise.all([
    import('../db'), import('../db/schema'), import('./store'), import('./wake'), import('./run-completion-delivery'), import('drizzle-orm'),
  ])
  const request = createRequestDatabaseScope(target!)
  const owner = `rule-persistence-${randomUUID()}`
  const priorKey = process.env.MIKKA_LITELLM_MASTER_KEY, priorUrl = process.env.MIKKA_LITELLM_URL
  delete process.env.MIKKA_LITELLM_MASTER_KEY
  delete process.env.MIKKA_LITELLM_URL
  t.after(async () => {
    if (priorKey === undefined) delete process.env.MIKKA_LITELLM_MASTER_KEY; else process.env.MIKKA_LITELLM_MASTER_KEY = priorKey
    if (priorUrl === undefined) delete process.env.MIKKA_LITELLM_URL; else process.env.MIKKA_LITELLM_URL = priorUrl
    await request.close()
  })
  await request.run(async () => {
    await db.execute(sql`insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values(${owner},'Rule fixture',${`${owner}@example.invalid`},false,now(),now())`)
    const { botId, workspaceId } = await seedCoordinator(owner)
    const identity = { userId: owner, botId }
    const agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID(), eventId = randomUUID()
    await db.insert(schema.agents).values({ id: agentId, userId: owner, harness: 'claude_code', name: 'Rule fixture' })
    await db.insert(schema.issues).values({ id: issueId, userId: owner, workspaceId, title: 'Failed fixture', content: { type: 'doc', content: [] }, status: 'todo', priority: 'normal' })
    await db.insert(schema.agentRuns).values({ id: runId, userId: owner, agentId, botId, issueId, status: 'failed', stopReason: 'error', finishedAt: new Date() })
    // No canonical stopReason in the source event: completion transport refuses it.
    await db.insert(schema.coordinatorEvents).values({ id: eventId, userId: owner, botId, issueId, runId, kind: 'run_finished', dedupeKey: eventId, payload: { status: 'failed', summary: 'Synthetic failed result' }, createdAt: sql`'2026-11-20T01:00:00.123456Z'::timestamptz` })
    const [event] = await store.untriagedEvents(owner, botId)
    assert.equal(event.id, eventId)
    assert.deepEqual([event.observedRun?.id, event.observedRun?.status], [runId, 'failed'])
    assert.ok(event.observedRun?.finishedAt)
    assert.equal(await deliverRunCompletion(pool, event, identity, pool), false)

    await wake.triageInbox(owner, botId)
    const state = async () => (await db.select().from(schema.coordinatorEvents).where(eq(schema.coordinatorEvents.id, eventId)))[0]
    const classified = await state()
    assert.equal(classified.tier, 'result')
    assert.equal(classified.triageDecision?.method, 'rule')
    assert.equal(classified.triageDecision?.reason, 'failed_run_completion')
    assert.equal(classified.triageDecision?.lastErrorReason, 'litellm_not_configured')
    assert.equal(classified.triageDecision?.execution, undefined, 'a rule completion must not fabricate a persisted model receipt')
    assert.ok(classified.lastTriageAttemptAt)
    assert.equal(classified.deliveredAt, null)
    assert.deepEqual(await store.untriagedEvents(owner, botId), [])

    await wake.wakeCoordinator(owner)
    assert.deepEqual(handedOff, [eventId], 'real wake query selected the rule-tier event')
    assert.equal((await state()).deliveredAt, null, 'failed native Eve acceptance leaves a retryable outbox event')
    assert.equal((await db.select().from(schema.coordinatorMessages).where(eq(schema.coordinatorMessages.userId, owner))).length, 0)
    refuseDelivery = false
    await wake.wakeCoordinator(owner)
    const delivered = await state()
    assert.ok(delivered.deliveredAt, 'real Eve acceptance transaction consumed the event')
    assert.equal(delivered.tier, 'result')
    assert.deepEqual(delivered.triageDecision, classified.triageDecision)
    const messages = await db.select().from(schema.coordinatorMessages).where(eq(schema.coordinatorMessages.userId, owner))
    assert.equal(messages.length, 1)
    assert.equal(messages[0].message.mikkaEveAccepted, true)
    assert.match(JSON.stringify(messages[0].message), /Synthetic failed result/)
    assert.equal(await wake.replayCoordinatorWake(eventId), false, 'accepted event is no longer pending')
    await wake.wakeCoordinator(owner)
    assert.deepEqual(handedOff, [eventId, eventId])
    assert.equal((await db.select().from(schema.coordinatorMessages).where(eq(schema.coordinatorMessages.userId, owner))).length, 1)
    t.diagnostic('PG rule receipt persisted; rejected Eve send stayed pending without a message; accepted send set deliveredAt and projected exactly one message')
  })
})
