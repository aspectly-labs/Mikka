import { driveResponse } from '@/lib/drive/server'
import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceResponse } from '@/lib/governance/http'
import { defineRoute } from '@/lib/primitives/define-route'


const POSTBody = freshSessionRoute(async (request: Request, context: { params: Promise<{ organizationId: string; volumeId: string }> }) =>
  governanceResponse(async () => driveResponse(request, 'restore', await context.params)))

export const POST = defineRoute<'public', 'none', { organizationId: string; volumeId: string }>(
  {
    route: '/api/organizations/[organizationId]/drive/[volumeId]/restore',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => POSTBody(request, { params: Promise.resolve(params) }),
)
