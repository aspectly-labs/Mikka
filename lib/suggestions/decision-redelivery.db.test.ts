import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { seedUser } from '../../tests/support/workspace-admin-db'
import { seedCoordinator } from '../../tests/support/coordinator-bot'
import { DECISION_MODEL, DECISIONS_PATH } from '../../lib/coordinator/decision'

const target = process.env.E2E_DATABASE_URL
assert.ok(target && disposableDatabase(process.env, target)
  && process.env.MIKKA_DATABASE_URL === target && process.env.DATABASE_URL === target,
  'the repro requires the isolated loopback database')

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return 'http://127.0.0.1:' + (server.address() as { port: number }).port
}

async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}

test('a transient missing decision must remain recoverable through the same authenticated webhook delivery', { timeout: 90_000 }, async t => {
  let answerLevel: 'high' | 'low' | null = null
  let attentionCalls = 0
  let mixedCommit: Promise<void> | null = null
  let mixedCalls = 0
  const boundaryErrors: unknown[] = []
  const provider = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer synthetic-no-decision-only')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (request.url === DECISIONS_PATH) {
        assert.equal(body.model, DECISION_MODEL)
        const attention = body.questions.some((question: { name: string }) => question.name === 'level')
        if (attention) attentionCalls++
        let level = answerLevel
        if (attention && mixedCommit) {
          level = ++mixedCalls === 1 ? 'high' : null
          // The second answer arrives only after the first recipient's real
          // INSERT commits. This makes the mixed-result ordering deterministic.
          if (!level) await mixedCommit
        }
        response.writeHead(200, { 'content-type': 'application/json', 'x-litellm-call-id': 'synthetic-' + randomUUID(), 'x-litellm-response-cost': '0.000001' })
        response.end(JSON.stringify({ model: DECISION_MODEL, answers: attention && level ? [
          { type: 'choice', name: 'level', choice: level },
          { type: 'predicate', name: 'handOver', probability: 0 },
        ] : [] }))
      } else {
        assert.equal(request.url, '/v1/chat/completions')
        const prompt = JSON.parse(body.messages.find((message: { role: string }) => message.role === 'user').content)
        const content = JSON.stringify({ titles: prompt.notifications.map((item: { id: string }) => ({ id: item.id, title: '处理测试通知' })) })
        response.writeHead(200, { 'content-type': 'application/json', 'x-litellm-call-id': 'synthetic-' + randomUUID(), 'x-litellm-response-cost': '0.000001' })
        response.end(JSON.stringify({ id: 'synthetic-title', object: 'chat.completion', model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } }))
      }
    } catch (error) { boundaryErrors.push(error); response.writeHead(500).end() }
  })
  const providerOrigin = await listen(provider)
  let route: (request: Request) => Promise<Response>
  let appOrigin = ''
  const app = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const headers = new Headers()
      for (let i = 0; i < request.rawHeaders.length; i += 2) headers.append(request.rawHeaders[i], request.rawHeaders[i + 1])
      const result = await route(new Request(appOrigin + request.url, { method: request.method, headers, body: Buffer.concat(chunks) }))
      response.writeHead(result.status, Object.fromEntries(result.headers))
      response.end(Buffer.from(await result.arrayBuffer()))
    } catch (error) { boundaryErrors.push(error); response.writeHead(500).end() }
  })
  appOrigin = await listen(app)
  const overrides = {
    MIKKA_EDITION: 'community',
    MIKKA_LITELLM_URL: providerOrigin,
    MIKKA_LITELLM_MASTER_KEY: 'synthetic-no-decision-only',
    MIKKA_CLOUD_URL: providerOrigin + '/mikka/cloud',
    MIKKA_BASE_PATH: '/mikka',
    BETTER_AUTH_URL: appOrigin,
    WORKSPACE_SECRETS_KEY: randomBytes(32).toString('base64'),
  }
  const old = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]))
  Object.assign(process.env, overrides)
  const [{ pool }, { workspacePool }, { sealSecret }, { POST }, { failedDeliveries }] = await Promise.all([
    import('../../lib/db'),
    import('../../lib/workspace-db'),
    import('../../lib/secrets/crypto'),
    import('../../app/api/cloud/webhooks/github/route'),
    import('../../lib/suggestions/github-redelivery'),
  ])
  route = POST
  let userId: string | undefined
  const people: string[] = []
  const serverId = randomUUID(), secret = 'mcs_' + randomBytes(32).toString('base64url')
  const deliveries = Array.from({ length: 7 }, () => randomUUID())
  const commitChannel = 'decision_commit_' + randomUUID().replaceAll('-', '')
  let commitListener: Awaited<ReturnType<typeof pool.connect>> | undefined
  t.after(async () => {
    await Promise.all([close(app), close(provider)])
    if (commitListener) {
      await commitListener.query('UNLISTEN *')
      commitListener.release()
      await pool.query(`DROP TRIGGER IF EXISTS "${commitChannel}" ON suggestions; DROP FUNCTION IF EXISTS "${commitChannel}"()`)
    }
    await pool.query('DELETE FROM cloud_github_webhook_receipts WHERE delivery_id=ANY($1::text[])', [deliveries])
    await pool.query('DELETE FROM cloud_service_registration WHERE server_id=$1', [serverId])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [people])
    await (await import('../../lib/builtin-gateway/runtime')).builtinGateway()?.stop()
    await Promise.all([pool.end(), workspacePool.end()])
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    assert.deepEqual(boundaryErrors, [], 'only the intended missing answer is injected')
  })
  const encrypted = sealSecret(JSON.stringify({ serverSecret: secret }), ['cloud_service_client', 'registration', serverId].join('\0'))
  await pool.query('INSERT INTO cloud_service_registration (server_id,origin,base_path,service_url,secret) VALUES($1,$2,$3,$4,$5)',
    [serverId, appOrigin, '/mikka', providerOrigin + '/mikka/cloud', encrypted])
  userId = await seedUser(pool, 'notification-no-decision')
  people.push(userId)
  await seedCoordinator(userId)
  const githubId = '999999991'
  await pool.query('INSERT INTO github_connections ("userId","githubAccountId","githubLogin","accessToken") VALUES($1,$2,$3,$4)',
    [userId, githubId, 'synthetic-notification-recipient', 'synthetic-unused-connection-token'])
  const payload = {
    action: 'assigned',
    assignee: { id: Number(githubId), login: 'synthetic-notification-recipient' },
    sender: { id: 999999992, login: 'synthetic-notification-sender', type: 'User' },
    repository: { full_name: 'synthetic-notification-owner/nonexistent-fixture' },
    issue: { id: 999999993, number: 1, title: 'Synthetic assigned notification', body: 'A deterministic fixture requiring a response.', updated_at: new Date().toISOString() },
  }
  const body = JSON.stringify(payload)
  async function send(delivery: string, valid = true, rawBody = body) {
    const seconds = String(Math.floor(Date.now() / 1000))
    const signature = createHmac('sha256', valid ? secret : 'synthetic-wrong-key').update(seconds + '.' + rawBody).digest('hex')
    const response = await fetch(appOrigin + '/mikka/api/cloud/webhooks/github', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': delivery,
        'Mikka-Cloud-Signature': 't=' + seconds + ',v1=' + signature }, body: rawBody })
    await response.arrayBuffer()
    return response.status
  }
  async function state(delivery: string, person = userId) {
    const { rows: [row] } = await pool.query(`SELECT
      (SELECT count(*)::int FROM suggestions WHERE "userId"=$1) AS suggestions,
      (SELECT count(*)::int FROM attention_matters WHERE "userId"=$1) AS matters,
      (SELECT completed_at IS NOT NULL FROM cloud_github_webhook_receipts WHERE delivery_id=$2) AS completed`, [person, delivery])
    return row as { suggestions: number; matters: number; completed: boolean | null }
  }
  const denied = await send(deliveries[0], false)
  assert.equal(denied, 401)
  assert.deepEqual(await state(deliveries[0]), { suggestions: 0, matters: 0, completed: null })
  assert.equal(attentionCalls, 0, 'an invalid HMAC does not reach decision admission')

  const firstStatus = await send(deliveries[1])
  const initial = await state(deliveries[1]), firstAttentionCalls = attentionCalls
  assert.equal(firstAttentionCalls, 1, 'real recipient resolution and model admission reach the loopback Decisions HTTP fixture')
  assert.equal(initial.suggestions, 0)

  answerLevel = 'high'
  const retryStatus = await send(deliveries[1])
  const retried = await state(deliveries[1]), retryAttentionCalls = attentionCalls - firstAttentionCalls
  const now = new Date()
  const eligible = failedDeliveries([{ id: '1', guid: deliveries[1], delivered_at: now.toISOString(), redelivery: false, status_code: firstStatus, event: 'issues' }], new Date(now.getTime() - 60_000))

  // A fresh delivery is a diagnostic control, not a proposed recovery strategy.
  const controlStatus = await send(deliveries[2])
  const control = await state(deliveries[2])
  assert.equal(controlStatus, 202)
  assert.equal(control.suggestions, 1, 'the unchanged recipient and healthy fixture really can persist this notification')
  assert.equal(control.matters, 0, 'the fixture explicitly declines a coordinator handoff')

  answerLevel = 'low'
  const lowBody = JSON.stringify({ ...payload, issue: { ...payload.issue, number: 2, title: 'Synthetic quiet notification' } })
  const lowStatus = await send(deliveries[3], true, lowBody)
  const lowState = await state(deliveries[3])
  assert.equal(lowStatus, 202)
  assert.deepEqual(lowState, { suggestions: 2, matters: 0, completed: true })
  const { rows: [visibility] } = await pool.query(`SELECT count(*) FILTER (WHERE shown)::int AS visible,
    count(*) FILTER (WHERE level='low' AND NOT shown)::int AS quiet FROM suggestions WHERE "userId"=$1`, [userId])
  assert.deepEqual(visibility, { visible: 1, quiet: 1 }, 'a valid low decision is durable and hidden, not missing evidence')
  const afterLowDecision = attentionCalls
  assert.equal(await send(deliveries[3], true, lowBody), 204)
  assert.equal(attentionCalls, afterLowDecision, 'replaying a valid low decision adds no model call')

  const unownedBody = JSON.stringify({ ...payload, assignee: { id: 999999994, login: 'synthetic-unconnected-person' } })
  const beforeUnowned = attentionCalls
  const unownedStatus = await send(deliveries[4], true, unownedBody)
  assert.equal(unownedStatus, 202)
  assert.deepEqual(await state(deliveries[4]), { suggestions: 2, matters: 0, completed: true })
  assert.equal(attentionCalls, beforeUnowned, 'no local recipient is a legitimate no-op without a model call')
  // A previous success for one real owner cannot mark another owner's notice as handled.
  const secondUser = await seedUser(pool, 'notification-second-recipient')
  people.push(secondUser)
  await seedCoordinator(secondUser)
  await pool.query('INSERT INTO github_connections ("userId","githubAccountId","githubLogin","accessToken") VALUES($1,$2,$3,$4)',
    [secondUser, githubId, 'synthetic-notification-recipient', 'synthetic-unused-connection-token'])
  answerLevel = null
  const beforePartial = attentionCalls
  const partialStatus = await send(deliveries[5])
  const partial = await state(deliveries[5], secondUser)
  assert.equal(attentionCalls - beforePartial, 1, 'the already stored owner is not scored again')
  assert.equal((await state(deliveries[5])).suggestions, 2)
  assert.equal(partial.suggestions, 0)
  answerLevel = 'high'
  const beforePartialRetry = attentionCalls
  const partialRetryStatus = await send(deliveries[5])
  const partialRetry = await state(deliveries[5], secondUser)
  const partialRetryCalls = attentionCalls - beforePartialRetry
  assert.equal((await state(deliveries[5])).suggestions, 2, 'the first owner retains its own rows')

  const [{ writeSuggestionSource }, { ingestNotifications }] = await Promise.all([
    import('../../lib/suggestions/source-settings'), import('../../lib/suggestions/store'),
  ])
  await writeSuggestionSource(userId, 'gmail', false)
  const beforeDisabled = attentionCalls
  answerLevel = null
  await ingestNotifications([{ userId, source: 'gmail', externalId: randomUUID(), matterKey: 'synthetic-disabled-mail', action: 'read',
    title: 'Synthetic disabled source', url: null, actor: null, occurredAt: new Date(), required: false, direct: false,
    fromSelf: false, automated: false, excerpt: 'Synthetic disabled source.' }])
  assert.equal(attentionCalls, beforeDisabled, 'an explicitly disabled source stays a no-op even while decisions are unavailable')

  console.log('notification_no_decision_observation=' + JSON.stringify({
    firstStatus, initial, firstAttentionCalls, retryStatus, retried, retryAttentionCalls,
    existingBackfillEligible: eligible.length, controlStatus, control,
    partialRecipient: { status: partialStatus, initial: partial, retryStatus: partialRetryStatus, retried: partialRetry, retryAttentionCalls: partialRetryCalls },
    legalNegative: { lowStatus, lowState, visibility, duplicateAdditionalDecisions: 0 },
    unowned: { status: unownedStatus, additionalDecisions: 0 },
    actualRoute: '/api/cloud/webhooks/github', realHttp: true, realPg: true, liveModel: false,
  }))
  assert.equal(retried.suggestions, 1,
    'after the decision provider recovers, replaying the original delivery must persist the notification instead of suppressing it with a completed receipt')
  assert.equal(firstStatus, 503)
  assert.equal(initial.completed, false)
  assert.equal(retryStatus, 202)
  assert.equal(retryAttentionCalls, 1)
  assert.equal(eligible.length, 1, 'the existing failed-delivery rule accepts the original failure')
  assert.equal(partialStatus, 503)
  assert.equal(partial.completed, false)
  assert.equal(partialRetryStatus, 202)
  assert.equal(partialRetry.suggestions, 1, 'the previously unresolved owner recovers its own notice')
  assert.equal(partialRetryCalls, 1, 'only the unresolved owner is scored on redelivery')

  const mixedTitle = 'Synthetic mixed notification ' + randomUUID()
  const mixedBody = JSON.stringify({ ...payload, issue: { ...payload.issue, number: 3, title: mixedTitle } })
  commitListener = await pool.connect()
  mixedCommit = new Promise<void>(resolve => {
    commitListener!.on('notification', event => { if (event.channel === commitChannel) resolve() })
  })
  await commitListener.query(`LISTEN "${commitChannel}"`)
  await pool.query(`CREATE FUNCTION "${commitChannel}"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_notify('${commitChannel}', NEW."userId"); RETURN NEW; END $$;
    CREATE TRIGGER "${commitChannel}" AFTER INSERT ON suggestions FOR EACH ROW
    WHEN (NEW.title = '${mixedTitle}') EXECUTE FUNCTION "${commitChannel}"()`)
  const mixedStatus = await send(deliveries[6], true, mixedBody)
  const { rows: mixedRows } = await pool.query('SELECT "userId", "actionTitle" FROM suggestions WHERE "userId"=ANY($1::text[]) AND title=$2', [people, mixedTitle])
  assert.equal(mixedStatus, 503)
  assert.equal(mixedCalls, 2)
  assert.equal((await state(deliveries[6])).completed, false)
  assert.equal(mixedRows.length, 1, 'the recipient with valid evidence commits independently')
  assert.equal(mixedRows[0].actionTitle, '处理测试通知', 'an unresolved recipient must not skip the new successful recipient\'s post-loop title processing')
  mixedCommit = null
  answerLevel = 'high'
  const beforeMixedRetry = attentionCalls
  assert.equal(await send(deliveries[6], true, mixedBody), 202)
  assert.equal(attentionCalls - beforeMixedRetry, 1, 'the mixed delivery retry only judges the unresolved recipient')
  const { rows: mixedRetry } = await pool.query('SELECT "actionTitle" FROM suggestions WHERE "userId"=ANY($1::text[]) AND title=$2', [people, mixedTitle])
  assert.equal(mixedRetry.length, 2)
  assert.ok(mixedRetry.every(row => row.actionTitle === '处理测试通知'))
  console.log('notification_mixed_decision_observation=' + JSON.stringify({
    status: mixedStatus, initialSuggestions: mixedRows.length, initialTitleWritten: true,
    decisionsBeforeRetry: mixedCalls, additionalDecisionsOnRetry: attentionCalls - beforeMixedRetry,
    recoveredSuggestions: mixedRetry.length, realCommitBeforeMissingAnswer: true,
  }))
})
