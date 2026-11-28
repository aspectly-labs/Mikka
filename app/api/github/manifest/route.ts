import { githubAppManifestRoutes } from '@/lib/github/manifest-runtime'
import { freshSessionRoute } from '@/lib/fresh-session'
import { withRequestLog } from '@/lib/request-log'
import { defineRoute } from '@/lib/primitives/define-route'

const unguardedGET = freshSessionRoute(withRequestLog('/api/github/manifest', githubAppManifestRoutes.GET))
const unguardedPOST = freshSessionRoute(withRequestLog('/api/github/manifest', githubAppManifestRoutes.POST))
export const GET = defineRoute(
  { auth: 'public', origin: 'any', workspace: 'none' },
  ({ request }) => unguardedGET(request),
)
export const POST = defineRoute(
  { auth: 'public', origin: 'any', workspace: 'none' },
  ({ request }) => unguardedPOST(request),
)
