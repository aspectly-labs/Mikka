import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationSummary, renameOrganization, updateOrganizationProfile, archiveOrganization } from '@/lib/governance/organizations'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { organizationSession } from '@/lib/enterprise/http'
import { WORKSPACE_ICON_MAX_BYTES } from '@/lib/workspace-admin/icon'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ organizationId: string }> }

const GETBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return organizationSummary(organizationId, session.user.id)
}))
const PUTBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  return renameOrganization(organizationId, session.user.id, await governanceJson(request))
}))
const PATCHBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId)
  const maxBytes = Math.ceil(WORKSPACE_ICON_MAX_BYTES / 3) * 4 + 2048
  return updateOrganizationProfile(organizationId, session.user.id, await governanceJson(request, maxBytes))
}))
const DELETEBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId, true)
  return archiveOrganization(organizationId, session.user.id)
}))

export const GET = defineRoute<'public', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)

export const PUT = defineRoute<'public', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request, params }) => PUTBody(request, { params: Promise.resolve(params) }),
)

export const PATCH = defineRoute<'public', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request, params }) => PATCHBody(request, { params: Promise.resolve(params) }),
)

export const DELETE = defineRoute<'public', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request, params }) => DELETEBody(request, { params: Promise.resolve(params) }),
)
