import { afterJob } from '@/lib/background'
import { verifyComposioWebhook } from '@/lib/composio-webhook'
import { composioNotification } from '@/lib/suggestions/notification'
import { ingestNotifications } from '@/lib/suggestions/store'
import { defineRoute } from '@/lib/primitives/define-route'

const noStore = { 'Cache-Control': 'no-store' }
type VerifiedComposio = Awaited<ReturnType<typeof verifyComposioWebhook>>

async function verify(request: Request) {
  const apiKey = process.env.COMPOSIO_API_KEY
  const verifySecret = process.env.COMPOSIO_WEBHOOK_SECRET
  if (!apiKey || !verifySecret) return new Response('Webhook is not configured.', { status: 503, headers: noStore })
  try {
    return { ok: true as const, payload: await verifyComposioWebhook(request, apiKey, verifySecret) }
  } catch {
    return new Response('Invalid webhook.', { status: 401, headers: noStore })
  }
}

export const POST = defineRoute<'webhook-signature', 'none', Record<string, string>, VerifiedComposio>(
  {
    route: '/api/webhooks/composio',
    auth: 'webhook-signature',
    origin: 'any',
    workspace: 'none',
    verifyWebhook: verify,
  },
  async ({ webhook: verified }) => {
    if (!verified) return new Response('Invalid webhook.', { status: 401, headers: noStore })
    // Trigger events from Gmail, Slack and Notion become suggestions; anything else is acknowledged.
    const notification = verified.payload.userId ? composioNotification(verified.payload) : null
    if (notification) {
      afterJob('after:composio-webhook', async () => {
        try { await ingestNotifications([notification]) }
        catch (error) { console.error('Composio suggestion ingest failed', error instanceof Error ? error.message : error) }
      })
    }
    return new Response(null, { status: 204, headers: noStore })
  },
)
