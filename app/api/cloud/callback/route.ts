import { cloudRoutes } from '@/lib/cloud-services/routes'
import { defineRoute } from '@/lib/primitives/define-route'

// Self-hosted-only edition gate (403 on Cloud) and fresh browser session (readServerSession) run inside cloudRoutes.
export const GET = defineRoute(
  { auth: 'public', origin: 'any', workspace: 'none', route: '/api/cloud/callback' },
  ({ request }) => cloudRoutes.callback(request),
)
