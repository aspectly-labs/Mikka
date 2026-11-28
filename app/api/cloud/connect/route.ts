import { cloudRoutes } from '@/lib/cloud-services/routes'
import { defineRoute } from '@/lib/primitives/define-route'

// Self-hosted edition gate, fresh browser session (readServerSession), and selfHostedAddress origin check run inside cloudRoutes.
export const POST = defineRoute(
  { auth: 'public', origin: 'any', workspace: 'none', route: '/api/cloud/connect' },
  ({ request }) => cloudRoutes.connect(request),
)
