import 'server-only'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { SubscriptionUse } from '@mikka/protocol/subscription'
import { decodeHostedCallId, hostedCallId } from './model-gateway/hosted-call-id.mjs'
import { stepIdentity } from './model-call-timing'
import { captureTraceContext } from './tracing/context'

const TICKET_VALIDITY_MS = 60_000
export const SUBSCRIPTION_CHAT_MAX_BYTES = 1_048_576
const boundary = 'mikka/subscription/chat/v1\0'
const intentSchema = z.object({
  use: z.object({ ownerId: z.string().min(1).max(256), workspaceId: z.uuid(), bindingId: z.uuid(),
    consumerId: z.string().min(1).max(256), execution: z.literal('model'), runId: z.uuid().optional() }).strict(),
  model: z.string().min(1).max(128), callId: z.string().max(200), expires: z.number().int(),
  digest: z.string().length(43), traceparent: z.string().max(55).optional(),
}).strict()
export const chatEnvelopeSchema = z.object({ model: z.string().min(1).max(128), ticket: z.string().max(4096), payload: z.string() }).strict()
export type ChatEnvelope = z.infer<typeof chatEnvelopeSchema>
const signature = (key: Buffer, bytes: string) => createHmac('sha256', key).update(boundary).update(bytes).digest()
const digest = (payload: string) => createHash('sha256').update(payload, 'utf8').digest('base64url')

function chatSigningKey() {
  const applicationSecret = process.env.BETTER_AUTH_SECRET?.trim()
  if (!applicationSecret || applicationSecret.length < 32 ||
    applicationSecret === process.env.MIKKA_LITELLM_MASTER_KEY?.trim()) return null
  return createHmac('sha256', applicationSecret).update('mikka:subscription-chat-ticket-key:v1').digest()
}

export async function signSubscriptionChat(use: SubscriptionUse, model: string, payload: string) {
  const key = chatSigningKey()
  if (!key) throw new Error('subscription_chat_signing_unavailable')
  const callId = hostedCallId(randomUUID(), await stepIdentity())
  const intent = intentSchema.parse({ use: { ...use, execution: 'model' }, model, callId, expires: Date.now() + TICKET_VALIDITY_MS,
    digest: digest(payload), traceparent: captureTraceContext()?.traceparent })
  const bytes = Buffer.from(JSON.stringify(intent)).toString('base64url')
  return { callId, body: JSON.stringify({ model, ticket: `${bytes}.${signature(key, bytes).toString('base64url')}`, payload } satisfies ChatEnvelope) }
}

export function verifySubscriptionChat(input: ChatEnvelope, now = Date.now()) {
  const key = chatSigningKey()
  if (!key) return null
  const [bytes, mac, extra] = input.ticket.split('.')
  if (!bytes || !mac || extra !== undefined || !/^[\w-]+$/.test(bytes) || !/^[\w-]{43}$/.test(mac)) return null
  const actual = Buffer.from(mac, 'base64url')
  if (actual.length !== 32 || !timingSafeEqual(actual, signature(key, bytes))) return null
  try {
    const intent = intentSchema.parse(JSON.parse(Buffer.from(bytes, 'base64url').toString('utf8')))
    if (!decodeHostedCallId(intent.callId) || intent.expires < now || intent.expires > now + TICKET_VALIDITY_MS
      || intent.model !== input.model || intent.digest !== digest(input.payload)) return null
    return intent
  } catch { return null }
}
