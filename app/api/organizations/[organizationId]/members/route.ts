import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { listOrganizationMembers, addOrganizationMember, updateOrganizationMember, removeOrganizationMember } from '@/lib/governance/organizations'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { organizationSession } from '@/lib/enterprise/http'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ organizationId: string }> }
const GETBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  const includeDisabled = z.enum(['true', 'false']).nullable().parse(new URL(request.url).searchParams.get('includeDisabled'))
  return listOrganizationMembers(organizationId, session.user.id, includeDisabled === 'true')
}))
const POSTBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return addOrganizationMember(organizationId, session.user.id, await governanceJson(request))
}))
const PATCHBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  await updateOrganizationMember(organizationId, session.user.id, await governanceJson(request))
  return { updated: true }
}))
const DELETEBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  const { userId } = z.object({ userId: z.string().min(1).max(200) }).strict().parse(await governanceJson(request))
  await removeOrganizationMember(organizationId, session.user.id, userId)
  return { removed: true }
}))

export const GET = defineRoute<'public', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]/members',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)

export const POST = defineRoute<'public', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]/members',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => POSTBody(request, { params: Promise.resolve(params) }),
)

export const PATCH = defineRoute<'public', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]/members',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => PATCHBody(request, { params: Promise.resolve(params) }),
)

export const DELETE = defineRoute<'public', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]/members',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => DELETEBody(request, { params: Promise.resolve(params) }),
)
