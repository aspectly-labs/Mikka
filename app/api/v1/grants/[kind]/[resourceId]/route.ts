import { accountApi, interopBody } from '@/lib/interop/http'
import { listAgentGrants, putAgentGrant } from '@/lib/interop/grants'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ kind: string; resourceId: string }> }

/** Bot, run and service grants on one thread, artifact, Bot, task or Bot chat. Owner or Workspace admin. */
const handleGET = async (request: Request, { params }: Context) => {
  const { kind, resourceId } = await params
  return accountApi(request, 'grants:read', manager => listAgentGrants(manager, kind, resourceId))
}

/** Create or replace one subject's grant. Only the resource's owner (`canManageAccess`). */
const handlePUT = async (request: Request, { params }: Context) => {
  const { kind, resourceId } = await params
  return accountApi(request, 'grants:write', async manager => ({ grant: await putAgentGrant(manager, kind, resourceId, await interopBody(request)) }))
}

export const GET = defineRoute<'public', 'none', { kind: string; resourceId: string }>(
  {
    route: '/api/v1/grants/[kind]/[resourceId]',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request, params }) => handleGET(request, { params: Promise.resolve(params) }),
)

export const PUT = defineRoute<'public', 'none', { kind: string; resourceId: string }>(
  {
    route: '/api/v1/grants/[kind]/[resourceId]',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request, params }) => handlePUT(request, { params: Promise.resolve(params) }),
)
