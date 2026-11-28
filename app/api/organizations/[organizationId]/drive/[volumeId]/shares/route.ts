import { driveResponse } from '@/lib/drive/server'
import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceResponse } from '@/lib/governance/http'
import { defineRoute } from '@/lib/primitives/define-route'


const volumeShares = freshSessionRoute(async (request: Request, context: { params: Promise<{ organizationId: string; volumeId: string }> }) =>
  governanceResponse(async () => driveResponse(request, 'links', await context.params)))

export const GET = defineRoute<'public', 'none', { organizationId: string; volumeId: string }>(
  {
    route: '/api/organizations/[organizationId]/drive/[volumeId]/shares',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => volumeShares(request, { params: Promise.resolve(params) }),
)

export const POST = defineRoute<'public', 'none', { organizationId: string; volumeId: string }>(
  {
    route: '/api/organizations/[organizationId]/drive/[volumeId]/shares',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => volumeShares(request, { params: Promise.resolve(params) }),
)
