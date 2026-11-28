import { humanSessionHeaders } from '@/lib/desktop-rpc/handler'
import { auth, type ApiSession } from '@/lib/api-auth'
import { noteLogUser } from '@/lib/request-log'
import { PluginError } from './contracts'

export async function pluginActor(
  request: Request,
  options: { humanOnly?: boolean } = {},
  authenticatedSession?: ApiSession,
) {
  let session: ApiSession | null | undefined
  if (options.humanOnly) {
    const headers = humanSessionHeaders(request)
    if (!headers) throw new PluginError('authRequired', 401)
    if (
      authenticatedSession
      && !request.headers.has('authorization')
      && !authenticatedSession.tokenId
      && !authenticatedSession.tokenWorkspaceId
    ) {
      session = authenticatedSession
    } else {
      session = await auth.api.getSession({ headers, query: { disableCookieCache: true } })
    }
  } else {
    session = authenticatedSession ?? await auth.api.getSession({ headers: request.headers })
  }
  noteLogUser(session?.user?.id)
  if (!session?.user) throw new PluginError('authRequired', 401)
  if (request.method !== 'GET' && request.headers.get('origin') !== new URL(request.url).origin) throw new PluginError('originNotAllowed', 403)
  return session.user.id
}
