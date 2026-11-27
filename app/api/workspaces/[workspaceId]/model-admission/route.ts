import { freshSessionRoute } from '@/lib/fresh-session'
import { auth, apiWorkspaceAllowed } from '@/lib/api-auth'
import { modelAdmission } from '@/lib/model-admission/runtime'
import { createModelAdmissionHandler } from '@/lib/model-admission/http'
import { humanSessionHeaders } from '@/lib/desktop-rpc/handler'
import { defineRoute } from '@/lib/primitives/define-route'

const handle = createModelAdmissionHandler({
  store: modelAdmission,
  async principal(request, workspaceId) {
    const sessionHeaders = humanSessionHeaders(request)
    if (!sessionHeaders) return null
    const session = await auth.api.getSession({ headers: sessionHeaders, query: { disableCookieCache: true } })
    return session?.user && apiWorkspaceAllowed(session, workspaceId) ? session.user.id : null
  },
})
type Context = { params: Promise<{ workspaceId: string }> }
const handleRequest = async (request: Request, { params }: Context) => handle(request, (await params).workspaceId)

export const GET = defineRoute<'public', 'none', { workspaceId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/model-admission',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    desktop: true,
  },
  ({ request, params }) => handleRequest(request, { params: Promise.resolve(params) }),
)

const POSTBody = defineRoute<'public', 'none', { workspaceId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/model-admission',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request, params }) => handleRequest(request, { params: Promise.resolve(params) }),
)

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
