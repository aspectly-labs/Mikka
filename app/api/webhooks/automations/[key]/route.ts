import { handleAutomationWebhook } from '@/lib/schedules/webhook-route'
import { defineRoute } from '@/lib/primitives/define-route'

/** An automation's webhook URL; lib/schedules/webhook-route.ts verifies the secret key before acting. */
export const POST = defineRoute<'public', 'none', { key: string }>(
  { route: '/api/webhooks/automations/[key]', auth: 'public', origin: 'any', workspace: 'none' },
  async ({ request, params }) => handleAutomationWebhook(request, params.key),
)
