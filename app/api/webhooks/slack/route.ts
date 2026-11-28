import { proxyEveRequest } from '@/lib/eve-service-proxy'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 60

/** Transparent proxy: Eve performs Slack's signature verification upstream. */
export const POST = defineRoute<'public', 'none'>(
  { route: '/api/webhooks/slack', auth: 'public', origin: 'any', workspace: 'none' },
  async ({ request }) => proxyEveRequest(request, '/eve/v1/slack'),
)
