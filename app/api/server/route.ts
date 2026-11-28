import { serverInfoResponse } from '@/lib/server-info'
import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute(
  { auth: 'public', origin: 'any', workspace: 'none', route: '/api/server' },
  ({ request }) => serverInfoResponse(request),
)
