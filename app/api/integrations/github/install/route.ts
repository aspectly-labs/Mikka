import { githubAppInstallUrlFromSlug } from '@/lib/github/install-url'
import { readGitHubAppConfig } from '@/lib/github/app-config'
import { beginCloudGitHubInstallation } from '@/lib/github/cloud'
import { CloudServiceError, cloudErrorStatus } from '@/lib/cloud-services/errors'
import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute(
  {
    route: '/api/integrations/github/install',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  async ({ session }) => {
    const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }
    let cloudUrl: string | null
    try { cloudUrl = await beginCloudGitHubInstallation(session.user.id) }
    catch (error) {
      if (error instanceof CloudServiceError) return Response.json({ error: error.code }, { status: cloudErrorStatus(error.code), headers })
      throw error
    }
    const url = cloudUrl ?? githubAppInstallUrlFromSlug((await readGitHubAppConfig()).slug)
    if (!url) return Response.json({ error: 'githubNotConfigured' }, { status: 503, headers })
    return new Response(null, { status: 302, headers: { ...headers, Location: url } })
  },
)
