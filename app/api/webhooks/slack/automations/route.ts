import { dispatchSlackAutomations, verifySlackAutomations } from '@/lib/slack/automation-route'
import { defineRoute } from '@/lib/primitives/define-route'

/** Slack events for 自动化 Slack triggers, forwarded by Eve; lib/slack/automation-route.ts. */
export const POST = defineRoute<'webhook-signature', 'none', Record<string, string>, unknown>(
  {
    route: '/api/webhooks/slack/automations',
    auth: 'webhook-signature',
    origin: 'any',
    workspace: 'none',
    verifyWebhook: request => verifySlackAutomations(request),
  },
  ({ webhook: payload }) => dispatchSlackAutomations(payload),
)
