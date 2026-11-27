import { decisionsHttp } from '@/lib/project-map/http'
import { defineRoute } from '@/lib/primitives/define-route'

const spec = { route: '/api/projects/[projectId]/decisions', auth: 'public', origin: 'any', workspace: 'none', desktop: true } as const

export const GET = defineRoute(spec, ({ request, params }) => decisionsHttp(request, params.projectId))
export const POST = defineRoute(spec, ({ request, params }) => decisionsHttp(request, params.projectId))
