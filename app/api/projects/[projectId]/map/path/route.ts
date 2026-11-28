import { projectMapHttp } from '@/lib/project-map/read-http'
import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute(
  { route: '/api/projects/[projectId]/map/path', auth: 'public', origin: 'any', workspace: 'none' },
  ({ request, params }) => projectMapHttp(request, params.projectId, 'path'),
)
