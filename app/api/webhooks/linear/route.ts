import { isLinearOAuthRevocation, parseLinearWebhookRequest } from '@/lib/linear-sync/webhook'
import { processLinearOAuthRevocation } from '@/lib/linear-sync/oauth-revocation'
import { defineRoute } from '@/lib/primitives/define-route'

type ParsedLinearWebhook = Extract<Awaited<ReturnType<typeof parseLinearWebhookRequest>>, { ok: true }>

async function verifyLinearWebhook(request: Request) {
  const parsed = await parseLinearWebhookRequest(request, process.env.LINEAR_WEBHOOK_SECRET)
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status })
  return { ok: true as const, payload: parsed }
}

export const POST = defineRoute<'webhook-signature', 'none', Record<string, string>, ParsedLinearWebhook>(
  {
    route: '/api/webhooks/linear',
    auth: 'webhook-signature',
    origin: 'any',
    workspace: 'none',
    verifyWebhook: verifyLinearWebhook,
  },
  async ({ webhook: parsed }) => {
    if (!parsed) return Response.json({ error: 'Invalid Linear webhook signature' }, { status: 401 })
    if ('ignored' in parsed) return new Response(null, { status: 200 })
    // 自动化 Linear triggers (decision 2026-11-15-1930) are not sync: they run whether sync is on or off, before the ACK,
    // so a failure is a 503 and Linear redelivers; the delivery ID makes a redelivery add nothing.
    const { fireLinearAutomations } = await import('@/lib/schedules/runtime')
    try { await fireLinearAutomations(parsed.deliveryId, parsed.payload) }
    catch { return Response.json({ error: 'Could not queue automations' }, { status: 503 }) }
    if (!isLinearOAuthRevocation(parsed.payload)) return Response.json({ disabled: true })
    try {
      await processLinearOAuthRevocation(parsed.payload)
      return new Response(null, { status: 200 })
    } catch {
      return Response.json({ error: 'Could not process revocation' }, { status: 503, headers: { 'retry-after': '60' } })
    }
  },
)
