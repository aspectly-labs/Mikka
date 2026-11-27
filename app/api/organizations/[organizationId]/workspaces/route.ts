import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { attachOrganizationWorkspace, detachOrganizationWorkspace } from '@/lib/governance/organizations'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { organizationSession } from '@/lib/enterprise/http'
import { defineRoute } from '@/lib/primitives/define-route'
type Context = { params: Promise<{ organizationId: string }> }
const input = z.object({ workspaceId: z.uuid() }).strict()

const POSTBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const session = await organizationSession(request, (await context.params).organizationId)
  const { workspaceId } = input.parse(await governanceJson(request))
  await attachOrganizationWorkspace((await context.params).organizationId, workspaceId, session.user.id)
  return { attached: true }
}))
const DELETEBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const session = await organizationSession(request, (await context.params).organizationId)
  const { workspaceId } = input.parse(await governanceJson(request))
  await detachOrganizationWorkspace((await context.params).organizationId, workspaceId, session.user.id)
  return { detached: true }
}))

export const POST = defineRoute<'public', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]/workspaces',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request, params }) => POSTBody(request, { params: Promise.resolve(params) }),
)

export const DELETE = defineRoute<'public', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]/workspaces',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request, params }) => DELETEBody(request, { params: Promise.resolve(params) }),
)
