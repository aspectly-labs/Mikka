import assert from 'node:assert/strict'
import { test } from 'node:test'
import { signSubscriptionChat, verifySubscriptionChat, type ChatEnvelope } from './subscription-chat-ticket'

const use = { ownerId: 'fixture-owner', workspaceId: 'a0000000-0000-4000-8000-000000000001',
  bindingId: 'a0000000-0000-4000-8000-000000000002', consumerId: 'coordinator', execution: 'model' as const }

test('LiteLLM chat ticket binds the exact model, payload, owner and short expiry', async () => {
  const values = { MIKKA_LITELLM_URL: 'http://127.0.0.1:4012', MIKKA_LITELLM_MASTER_KEY: 'synthetic-master-key-only' }
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  Object.assign(process.env, values)
  try {
    const { callId, body } = await signSubscriptionChat(use, 'fixture-chat', '{"model":"fixture-chat","stream":true}')
    const envelope: ChatEnvelope = JSON.parse(body)
    const intent = verifySubscriptionChat(envelope)
    assert.ok(intent)
    assert.equal(intent.callId, callId)
    assert.deepEqual(intent.use, use)
    assert.equal(verifySubscriptionChat({ ...envelope, model: 'another-model' }), null)
    assert.equal(verifySubscriptionChat({ ...envelope, payload: envelope.payload + ' ' }), null)
    assert.equal(verifySubscriptionChat(envelope, intent.expires + 1), null)
    const [claims, mac] = envelope.ticket.split('.')
    const edited = { ...intent, use: { ...use, ownerId: 'another-owner' } }
    assert.ok(claims && mac)
    assert.equal(verifySubscriptionChat({ ...envelope, ticket: `${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${mac}` }), null)
    process.env.MIKKA_LITELLM_MASTER_KEY = 'different-installation-key'
    assert.equal(verifySubscriptionChat(envelope), null)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
