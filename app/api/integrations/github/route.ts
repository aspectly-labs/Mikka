import { freshSessionRoute } from '@/lib/fresh-session'
import { GitHubAccessError, listAuthorizedRepositories } from '@/lib/github/user-access'
import { disconnectGitHub, githubConnectConfigured, githubConnection } from '@/lib/github/connection'
import { useCloudGitHub } from '@/lib/github/cloud'
import { CloudServiceError, cloudErrorStatus } from '@/lib/cloud-services/errors'
import { hasPatAuthorizationHeader, isPatSession, sameOriginMutationAllowed } from '@/lib/http-security'
import { defineRoute } from '@/lib/primitives/define-route'

const headers = { 'Cache-Control': 'private, no-store' }

export const GET = defineRoute(
  {
    route: '/api/integrations/github',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request, session }) => {
    let viewerId: string | null = null
    try {
      if (isPatSession(session)) return Response.json({ error: 'sessionRequired' }, { status: 403, headers })
      viewerId = session.user.id
      const result = await listAuthorizedRepositories(request.headers)
      if (result.userId !== viewerId) throw new GitHubAccessError('authRequired', 401)
      const connection = await githubConnection(viewerId)
      const cloud = await useCloudGitHub(viewerId)
      return Response.json({ viewerId, configured: true, connected: true, ...(cloud ? { source: 'cloud' } : {}),
        githubAccountId: result.githubAccountId, login: cloud ? null : connection?.githubLogin ?? null,
        installed: result.installations.length > 0, repositories: result.repositories }, { headers })
    } catch (error) {
      if (error instanceof CloudServiceError) return Response.json({ ...(viewerId ? { viewerId } : {}), error: error.code }, { status: cloudErrorStatus(error.code), headers })
      if (error instanceof GitHubAccessError) {
        if (viewerId && (error.code === 'githubNotConnected' || error.code === 'githubNotConfigured')) return Response.json({ viewerId, configured: error.code !== 'githubNotConfigured' && await githubConnectConfigured(), connected: false, installed: false, repositories: [] }, { headers })
        return Response.json({ ...(viewerId ? { viewerId } : {}), error: error.code }, { status: error.status, headers })
      }
      return Response.json({ ...(viewerId ? { viewerId } : {}), error: 'githubUnavailable' }, { status: 502, headers })
    }
  },
)

/** Removes only this user's Plugins → GitHub connection; the GitHub sign-in stays. */
const DELETEBody = defineRoute(
  {
    route: '/api/integrations/github',
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  async ({ request, session }) => {
    if (hasPatAuthorizationHeader(request) || isPatSession(session)) return Response.json({ error: 'sessionRequired' }, { status: 403, headers })
    if (!sameOriginMutationAllowed(request)) return Response.json({ error: 'originNotAllowed' }, { status: 403, headers })
    if (await useCloudGitHub(session.user.id)) return Response.json({ viewerId: session.user.id, error: 'cloud_access_denied' }, { status: 403, headers })
    await disconnectGitHub(session.user.id)
    return Response.json({ viewerId: session.user.id }, { headers })
  },
)

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const DELETE = freshSessionRoute(DELETEBody)
