import { auth } from '@/lib/auth'
import { noteLogUser } from '@/lib/request-log'
import { ActionFailureError } from '@/lib/action-error'
import { actionErrorStatus } from '@/lib/action-status'
import { WorkspaceError } from '@/lib/workspace-error'
import { createDesktopRpc } from '@/lib/desktop-rpc/handler'
import { desktopActions } from '@/lib/desktop-rpc/registry'
import { withDesktopLocale, desktopRotatedToken } from '@/lib/desktop-rpc/session'
import { desktopAuthentication } from '@/lib/desktop-rpc/authentication'
import { defineRoute } from '@/lib/primitives/define-route'
import { causeFields } from '@mikka/protocol/coded-error'

export const maxDuration = 300
const sessions = desktopAuthentication(input => auth.api.getSession(input), async () => (await auth.$context).authCookies.sessionData.name)

const handleRpc = createDesktopRpc({
  authenticate: async headers => {
    const authenticated = await sessions.authenticate(headers)
    if (authenticated) noteLogUser(authenticated.session.user.id)
    return authenticated
  },
  scope: (session, work, request) => withDesktopLocale(request.headers.get('x-mikka-locale') === 'en' ? 'en' : 'zh-CN', () => sessions.scope(session, async () => {
    const response = await work()
    const token = desktopRotatedToken()
    if (response.ok && token) response.headers.set('x-mikka-session-token', token)
    return response
  })),
  actions: desktopActions,
  error: error => {
    if (error instanceof ActionFailureError) return { status: actionErrorStatus(error.code), code: error.code }
    if (error instanceof WorkspaceError) return { status: 403, code: 'workspaceAccessDenied' }
    console.error('desktop_rpc_failed', { causes: causeFields(error) })
    return { status: 500, code: 'desktop_rpc_failed' }
  },
})

// Desktop/Web RPC authenticates via its own desktop bearer + session rotation envelope inside createDesktopRpc.
export const POST = defineRoute(
  { auth: 'public', origin: 'any', workspace: 'none', route: '/api/desktop/rpc', desktop: true },
  ({ request }) => handleRpc(request),
)
