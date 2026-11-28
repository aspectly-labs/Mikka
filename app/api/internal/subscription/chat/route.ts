import { defineRoute } from '@/lib/primitives/define-route'
import { handleSubscriptionChat } from '@/lib/subscription-chat-bridge'

export const maxDuration = 300
export const POST = defineRoute<'public', 'none'>(
  { route: '/api/internal/subscription/chat', auth: 'public', origin: 'any', workspace: 'none' },
  async ({ request }) => handleSubscriptionChat(request),
)
