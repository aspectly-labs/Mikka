import { driveResponse } from '@/lib/drive/server'
import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceResponse } from '@/lib/governance/http'
import { defineRoute } from '@/lib/primitives/define-route'


const GETBody = freshSessionRoute(async (request: Request, context: { params: Promise<{ organizationId: string; volumeId: string; versionId: string; sha256: string }> }) =>
  governanceResponse(async () => driveResponse(request, 'organizationVersionFile', await context.params)))

export const GET = defineRoute<'public', 'none', { organizationId: string; volumeId: string; versionId: string; sha256: string }>(
  {
    route: '/api/organizations/[organizationId]/drive/[volumeId]/versions/[versionId]/files/[sha256]',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)
