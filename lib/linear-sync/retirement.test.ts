import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mock, test } from 'node:test'

const automationDeliveries: string[] = []
let revocations = 0
let failRevocation = false
mock.module('@/lib/schedules/runtime', { namedExports: {
  fireLinearAutomations: async (id: string) => { automationDeliveries.push(id) },
} })
mock.module('./oauth-revocation', { namedExports: {
  processLinearOAuthRevocation: async () => {
    revocations++
    if (failRevocation) throw new Error('fixture failure')
  },
} })

test('retired cron authenticates and signed webhooks still deliver automations and revocations', async () => {
  const cron = await import('../../app/api/cron/linear-sync/route')
  const webhook = await import('../../app/api/webhooks/linear/route')
  process.env.CRON_SECRET = 'test-cron'
  process.env.LINEAR_WEBHOOK_SECRET = 'test-webhook'
  const cronRequest = (token: string) => new Request('https://app.invalid/mikka/api/cron/linear-sync', { headers: { authorization: `Bearer ${token}` } })
  assert.equal((await cron.GET(cronRequest('wrong'))).status, 401)
  assert.deepEqual(await (await cron.GET(cronRequest('test-cron'))).json(), { inbox: 0, outbox: 0, disabled: true })
  const makeRequest = (payload: Record<string, unknown>, eventType: string, signatureOverride?: string) => {
    const body = JSON.stringify(payload)
    const signature = signatureOverride ?? createHmac('sha256', 'test-webhook').update(body).digest('hex')
    return new Request('https://app.invalid/mikka/api/webhooks/linear', {
      method: 'POST', headers: { 'linear-event': eventType, 'linear-delivery': 'delivery', 'linear-signature': signature }, body,
    })
  }
  const ordinary = { action: 'update', type: 'Issue', organizationId: 'org', webhookTimestamp: Date.now(), data: { id: 'issue' } }
  assert.equal((await webhook.POST(makeRequest(ordinary, 'Issue', '0'.repeat(64)))).status, 401)
  assert.deepEqual(automationDeliveries, [], 'an unsigned delivery reaches no automation')
  const response = await webhook.POST(makeRequest(ordinary, 'Issue'))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { disabled: true })
  assert.deepEqual(automationDeliveries, ['delivery'], 'a signed delivery reaches automations with sync off')
  assert.equal(revocations, 0)

  const revoked = { action: 'remove', type: 'OAuthAuthorization', organizationId: 'org', webhookTimestamp: Date.now(), data: { userId: 'linear-user' } }
  const revokeResponse = await webhook.POST(makeRequest(revoked, 'OAuthAuthorization'))
  assert.equal(revokeResponse.status, 200)
  assert.equal(revocations, 1)

  failRevocation = true
  try {
    const retry = await webhook.POST(makeRequest(revoked, 'OAuthAuthorization'))
    assert.equal(retry.status, 503)
    assert.equal(retry.headers.get('retry-after'), '60')
    assert.deepEqual(await retry.json(), { error: 'Could not process revocation' })
  } finally { failRevocation = false }
})
