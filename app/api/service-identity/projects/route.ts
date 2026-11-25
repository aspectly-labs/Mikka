import { governanceResponse } from '@/lib/governance/http'
import { readServiceCredentialProjects } from '@/lib/governance/service-credentials'
import { defineRoute } from '@/lib/primitives/define-route'

const GETBody = (request: Request) => governanceResponse(async () => {
  const result = await readServiceCredentialProjects(request.headers.get('authorization'), { after: new URL(request.url).searchParams.get('after') })
  return result ?? Response.json({ error: 'authRequired' }, { status: 401, headers: { 'cache-control': 'private, no-store' } })
})

export const GET = defineRoute<'public', 'none'>(
  {
    route: '/api/service-identity/projects',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  ({ request }) => GETBody(request),
)
