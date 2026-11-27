import type { SubscriptionChatTransport } from '../../lib/subscription-service'

/** Tests of SDK serialization and callers isolate inference at the transport. */
export function fixtureSubscriptionChat<Payload>(worker: { stream(revision: number, model: string, payload: Payload, signal?: AbortSignal): ReadableStream<Uint8Array> }): SubscriptionChatTransport {
  return async (_use, model, payload, signal) => new Response(worker.stream(1, model, JSON.parse(payload), signal), {
    headers: { 'content-type': 'text/event-stream' },
  })
}
