import { governanceResponse } from '@/lib/governance/http'
import { readServiceCredentialProjects } from '@/lib/governance/service-credentials'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ projectId: string }> }

const GETBody = (request: Request, { params }: Context) => governanceResponse(async () => {
  const result = await readServiceCredentialProjects(request.headers.get('authorization'), await params)
  return result ?? Response.json({ error: 'authRequired' }, { status: 401, headers: { 'cache-control': 'private, no-store' } })
})

export const GET = defineRoute<'public', 'none', { projectId: string }>(
  {
    route: '/api/service-identity/projects/[projectId]',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)
