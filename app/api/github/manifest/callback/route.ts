import { githubAppManifestRoutes } from '@/lib/github/manifest-runtime'
import { freshSessionRoute } from '@/lib/fresh-session'
import { withRequestLog } from '@/lib/request-log'
import { defineRoute } from '@/lib/primitives/define-route'

const unguardedGET = freshSessionRoute(withRequestLog('/api/github/manifest/callback', githubAppManifestRoutes.callback))
export const GET = defineRoute(
  { auth: 'public', origin: 'any', workspace: 'none' },
  ({ request }) => unguardedGET(request),
)
