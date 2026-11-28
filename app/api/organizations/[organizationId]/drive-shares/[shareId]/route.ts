import { driveResponse } from '@/lib/drive/server'
import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceResponse } from '@/lib/governance/http'
import { defineRoute } from '@/lib/primitives/define-route'


type Context = { params: Promise<{ organizationId: string; shareId: string }> }

const manage = freshSessionRoute(async (request: Request, context: Context) =>
  governanceResponse(async () => driveResponse(request, 'shareView', await context.params)))

export const PATCH = defineRoute<'public', 'none', { organizationId: string; shareId: string }>(
  {
    route: '/api/organizations/[organizationId]/drive-shares/[shareId]',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => manage(request, { params: Promise.resolve(params) }),
)

export const DELETE = defineRoute<'public', 'none', { organizationId: string; shareId: string }>(
  {
    route: '/api/organizations/[organizationId]/drive-shares/[shareId]',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => manage(request, { params: Promise.resolve(params) }),
)
