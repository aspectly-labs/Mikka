import { decisionsHttp } from '@/lib/project-map/http'
import { defineRoute } from '@/lib/primitives/define-route'

export const POST = defineRoute(
  { route: '/api/projects/[projectId]/decisions/from-message', auth: 'public', origin: 'any', workspace: 'none', desktop: true },
  ({ request, params }) => decisionsHttp(request, params.projectId, true),
)
