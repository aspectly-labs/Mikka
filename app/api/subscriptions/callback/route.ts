import { defineRoute } from '@/lib/primitives/define-route'
import { subscriptionCallback } from '@/lib/subscription-http'
import { subscriptionHTTPDependencies } from '@/lib/subscription-http-runtime'

export const maxDuration = 60
export const GET = defineRoute(
  { auth: 'public', origin: 'any', workspace: 'none' },
  ({ request }) => subscriptionCallback(request, subscriptionHTTPDependencies),
)
