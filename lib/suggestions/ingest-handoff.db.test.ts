import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { seedUser } from '../../tests/support/workspace-admin-db'
import { seedCoordinator } from '../../tests/support/coordinator-bot'
import { DECISION_MODEL, DECISIONS_PATH } from '../../lib/coordinator/decision'
import type { ExternalNotification } from '../../lib/suggestions/notification'

const target = process.env.E2E_DATABASE_URL
const enabled = Boolean(target && disposableDatabase(process.env, target) && process.env.MIKKA_DATABASE_URL === target && process.env.DATABASE_URL === target)
if (process.env.REQUIRE_DB === '1') assert.ok(enabled, 'matching isolated loopback databases are required')

test('a failed attention write must leave a GitHub notification retryable', { skip: !enabled, timeout: 60_000 }, async t => {
  let attentionCalls = 0
  let handOver = true
  let barrier: { remaining: number; done: Promise<void>; release: () => void } | undefined
  const people: string[] = []
  const providerErrors: unknown[] = []
  const provider = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer synthetic-notification-only')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (request.url === DECISIONS_PATH) {
        assert.equal(body.model, DECISION_MODEL)
        const attention = body.questions.some((question: { name: string }) => question.name === 'level')
        if (attention) {
          attentionCalls++
          if (barrier) {
            if (--barrier.remaining === 0) barrier.release()
            await barrier.done
          }
        }
        response.writeHead(200, { 'content-type': 'application/json', 'x-litellm-call-id': 'synthetic-' + randomUUID(), 'x-litellm-response-cost': '0.000001' })
        response.end(JSON.stringify({ model: DECISION_MODEL, answers: attention ? [
          { type: 'choice', name: 'level', choice: 'high' },
          { type: 'predicate', name: 'handOver', probability: handOver ? 1 : 0 },
        ] : [] }))
      } else {
        assert.equal(request.url, '/v1/chat/completions')
        response.writeHead(200, { 'content-type': 'application/json', 'x-litellm-call-id': 'synthetic-' + randomUUID(), 'x-litellm-response-cost': '0.000001' })
        response.end(JSON.stringify({ id: 'synthetic-title', object: 'chat.completion', model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } }))
      }
    } catch (error) { providerErrors.push(error); response.writeHead(500).end() }
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const old = { MIKKA_EDITION: process.env.MIKKA_EDITION, MIKKA_LITELLM_URL: process.env.MIKKA_LITELLM_URL, MIKKA_LITELLM_MASTER_KEY: process.env.MIKKA_LITELLM_MASTER_KEY }
  Object.assign(process.env, { MIKKA_EDITION: 'community', MIKKA_LITELLM_URL: 'http://127.0.0.1:' + (provider.address() as { port: number }).port,
    MIKKA_LITELLM_MASTER_KEY: 'synthetic-notification-only' })
  const [{ pool }, { workspacePool }, { ingestNotifications }] = await Promise.all([
    import('../../lib/db'), import('../../lib/workspace-db'), import('../../lib/suggestions/store'),
  ])
  t.after(async () => {
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()))
    await pool.query('DROP TRIGGER IF EXISTS fixture_fail_attention ON attention_matters')
    await pool.query('DROP FUNCTION IF EXISTS fixture_fail_attention()')
    await pool.query('DROP TABLE IF EXISTS fixture_attention_failures')
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [people])
    await (await import('../../lib/builtin-gateway/runtime')).builtinGateway()?.stop()
    await Promise.all([pool.end(), workspacePool.end()])
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    assert.deepEqual(providerErrors, [])
  })
  await pool.query('CREATE TABLE fixture_attention_failures (owner_id text PRIMARY KEY)')
  await pool.query(`CREATE FUNCTION fixture_fail_attention() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF EXISTS (SELECT 1 FROM fixture_attention_failures WHERE owner_id=NEW."userId") THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='synthetic attention write failure';
    END IF; RETURN NEW; END $$`)
  await pool.query('CREATE TRIGGER fixture_fail_attention BEFORE INSERT OR UPDATE ON attention_matters FOR EACH ROW EXECUTE FUNCTION fixture_fail_attention()')
  async function notification(): Promise<ExternalNotification> {
    const userId = await seedUser(pool, 'notification-atomicity')
    people.push(userId)
    await seedCoordinator(userId)
    return { userId, source: 'github', externalId: randomUUID(), matterKey: 'github:' + randomUUID(), action: 'reply',
      title: 'Synthetic handoff', url: null, actor: 'Synthetic colleague', occurredAt: new Date(), required: true,
      direct: true, fromSelf: false, automated: false, excerpt: 'Synthetic request requiring a reply.' }
  }
  async function counts(userId: string) {
    const { rows: [row] } = await pool.query(`SELECT
      (SELECT count(*)::int FROM suggestions WHERE "userId"=$1) AS suggestions,
      (SELECT count(*)::int FROM attention_matters WHERE "userId"=$1) AS matters`, [userId])
    return row
  }
  async function fail(notification: ExternalNotification) {
    await pool.query('INSERT INTO fixture_attention_failures(owner_id) VALUES($1)', [notification.userId])
    await assert.rejects(ingestNotifications([notification]), error => {
      for (let cause = error, depth = 0; cause && depth < 8; cause = (cause as Error).cause, depth++)
        if ((cause as { code?: string }).code === 'P0001') return true
      return false
    })
    await pool.query('DELETE FROM fixture_attention_failures WHERE owner_id=$1', [notification.userId])
  }
  await t.test('a real SQL failure cannot leave the dedupe row committed without its handoff', async () => {
    const item = await notification(), before = attentionCalls
    await fail(item)
    assert.equal(attentionCalls, before + 1, 'the real decision and admission reached only the loopback provider')
    const observed = await counts(item.userId)
    console.log('notification_atomicity_observation=' + JSON.stringify({ phase: 'failed_write', ...observed }))
    assert.deepEqual(observed, { suggestions: 0, matters: 0 })
  })
  await t.test('redelivery after a temporary SQL failure repairs one handoff', async () => {
    const item = await notification()
    await fail(item)
    const before = attentionCalls
    await ingestNotifications([item])
    const observed = await counts(item.userId)
    console.log('notification_atomicity_observation=' + JSON.stringify({ phase: 'redelivery', ...observed, newDecisions: attentionCalls - before }))
    assert.deepEqual(observed, { suggestions: 1, matters: 1 })
  })
  await t.test('the successful path really persists a suggestion and its matter', async () => {
    const item = await notification()
    await ingestNotifications([item])
    assert.deepEqual(await counts(item.userId), { suggestions: 1, matters: 1 })
  })
  await t.test('concurrent duplicate deliveries commit one owned pair and a later duplicate does no scoring', async () => {
    const item = await notification()
    let release!: () => void
    const done = new Promise<void>(resolve => { release = resolve })
    barrier = { remaining: 6, done, release }
    try { await Promise.all(Array.from({ length: 6 }, () => ingestNotifications([item]))) }
    finally { release(); barrier = undefined }
    assert.deepEqual(await counts(item.userId), { suggestions: 1, matters: 1 })
    const before = attentionCalls
    await ingestNotifications([item])
    assert.equal(attentionCalls, before)
    assert.deepEqual(await counts(item.userId), { suggestions: 1, matters: 1 })
  })
  await t.test('the same source identifiers remain independent for two real owners', async () => {
    const first = await notification(), second = { ...await notification(), externalId: first.externalId, matterKey: first.matterKey }
    await Promise.all([ingestNotifications([first]), ingestNotifications([second])])
    assert.deepEqual(await counts(first.userId), { suggestions: 1, matters: 1 })
    assert.deepEqual(await counts(second.userId), { suggestions: 1, matters: 1 })
    const rows = (await pool.query('SELECT id,"userId" FROM attention_matters WHERE "userId"=ANY($1::text[])', [[first.userId, second.userId]])).rows
    assert.equal(new Set(rows.map(row => row.id)).size, 2)
  })
  await t.test('bootstrap routing, the personal switch and the model handoff decision retain their meaning', async () => {
    const bootstrap = await notification(), disabled = await notification(), quiet = await notification()
    const { setAttentionEnabled } = await import('../../lib/attention/store')
    await setAttentionEnabled(disabled.userId, false)
    await ingestNotifications([bootstrap], { route: false })
    await ingestNotifications([disabled])
    handOver = false
    try { await ingestNotifications([quiet]) } finally { handOver = true }
    for (const item of [bootstrap, disabled, quiet]) assert.deepEqual(await counts(item.userId), { suggestions: 1, matters: 0 })
  })
  await t.test('a failed update preserves the original matter and retry updates it without creating a second matter', async () => {
    const first = await notification()
    await ingestNotifications([first])
    const original = (await pool.query('SELECT id,"suggestionId" FROM attention_matters WHERE "userId"=$1', [first.userId])).rows[0]
    const second = { ...first, externalId: randomUUID(), title: 'Synthetic follow-up' }
    await fail(second)
    assert.deepEqual(await counts(first.userId), { suggestions: 1, matters: 1 })
    assert.deepEqual((await pool.query('SELECT id,"suggestionId" FROM attention_matters WHERE "userId"=$1', [first.userId])).rows[0], original)
    await ingestNotifications([second])
    const updated = (await pool.query('SELECT id,"suggestionId" FROM attention_matters WHERE "userId"=$1', [first.userId])).rows[0]
    assert.equal(updated.id, original.id)
    assert.notEqual(updated.suggestionId, original.suggestionId)
    assert.deepEqual(await counts(first.userId), { suggestions: 2, matters: 1 })
  })
})
