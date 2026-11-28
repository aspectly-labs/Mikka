import { accountApi } from '@/lib/interop/http'
import { deleteAgentGrant } from '@/lib/interop/grants'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ kind: string; resourceId: string; subjectKind: string; subjectId: string }> }

/** Revoke one Bot, run or service grant. Owner or Workspace admin. */
const handleDELETE = async (request: Request, { params }: Context) => {
  const { kind, resourceId, subjectKind, subjectId } = await params
  return accountApi(request, 'grants:write', manager => deleteAgentGrant(manager, kind, resourceId, subjectKind, subjectId))
}

export const DELETE = defineRoute<'public', 'none', { kind: string; resourceId: string; subjectKind: string; subjectId: string }>(
  {
    route: '/api/v1/grants/[kind]/[resourceId]/[subjectKind]/[subjectId]',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request, params }) => handleDELETE(request, { params: Promise.resolve(params) }),
)
