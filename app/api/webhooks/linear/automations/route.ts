import { parseLinearWebhookRequest } from '@/lib/linear-sync/webhook'
import { defineRoute } from '@/lib/primitives/define-route'

type ParsedLinearWebhook = Extract<Awaited<ReturnType<typeof parseLinearWebhookRequest>>, { ok: true }>

async function verifyLinearWebhook(request: Request) {
  const parsed = await parseLinearWebhookRequest(request, process.env.LINEAR_WEBHOOK_SECRET)
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status })
  return { ok: true as const, payload: parsed }
}

/**
 * Linear deliveries for 自动化 triggers (decision 2026-11-15-1930), forwarded by the Linear Worker that receives the
 * official app's webhook. The forward carries Linear's own headers and body, so the signature is checked here again
 * with the same secret; nothing else is trusted. 200 once queued (or nothing matched); 503 lets the Worker ask Linear
 * to redeliver.
 */
export const POST = defineRoute<'webhook-signature', 'none', Record<string, string>, ParsedLinearWebhook>(
  {
    route: '/api/webhooks/linear/automations',
    auth: 'webhook-signature',
    origin: 'any',
    workspace: 'none',
    verifyWebhook: verifyLinearWebhook,
  },
  async ({ webhook: parsed }) => {
    if (!parsed) return Response.json({ error: 'Invalid Linear webhook signature' }, { status: 401 })
    if ('ignored' in parsed) return Response.json({ queued: 0 })
    const { fireLinearAutomations } = await import('@/lib/schedules/runtime')
    try { return Response.json({ queued: await fireLinearAutomations(parsed.deliveryId, parsed.payload) }) }
    catch { return Response.json({ error: 'Could not queue automations' }, { status: 503 }) }
  },
)
