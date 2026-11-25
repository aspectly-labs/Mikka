import { readGitHubWebhookBody } from '@/lib/github/webhook-dispatch'
import { validSlackSignature } from '@/lib/slack/webhook'
import { defineRoute } from '@/lib/primitives/define-route'

const MAX_BYTES = 1_000_000
const noStore = { 'Cache-Control': 'no-store' }

async function verifySlackAutomationWebhook(request: Request) {
  const secret = process.env.SLACK_SIGNING_SECRET
  if (!secret || !process.env.SLACK_APP_ID) return Response.json({ error: 'Slack is not configured' }, { status: 503, headers: noStore })
  const raw = await readGitHubWebhookBody(request, MAX_BYTES)
  if (raw === null) return Response.json({ error: 'Payload too large' }, { status: 413, headers: noStore })
  if (!validSlackSignature(raw, request.headers.get('x-slack-request-timestamp'), request.headers.get('x-slack-signature'), secret)) {
    return Response.json({ error: 'Invalid signature' }, { status: 401, headers: noStore })
  }
  try {
    return { ok: true as const, payload: JSON.parse(raw) as unknown }
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: noStore })
  }
}

/** Slack events for 自动化 Slack triggers, forwarded by Eve with Slack's own body and signature headers. */
export const POST = defineRoute<'webhook-signature', 'none', Record<string, string>, unknown>(
  {
    route: '/api/webhooks/slack/automations',
    auth: 'webhook-signature',
    origin: 'any',
    workspace: 'none',
    verifyWebhook: verifySlackAutomationWebhook,
  },
  async ({ webhook: payload }) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (payload as { api_app_id?: unknown }).api_app_id !== process.env.SLACK_APP_ID) {
      return Response.json({ queued: 0 }, { headers: noStore })
    }
    const { fireSlackAutomations } = await import('@/lib/schedules/runtime')
    try { return Response.json({ queued: await fireSlackAutomations(payload as Record<string, unknown>) }, { headers: noStore }) }
    catch { return Response.json({ error: 'Could not queue automations' }, { status: 503, headers: noStore }) }
  },
)
