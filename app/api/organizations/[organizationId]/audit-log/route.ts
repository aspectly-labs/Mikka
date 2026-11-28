import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { createOrganizationAuditExport, listOrganizationAuditEvents, readOrganizationAuditExport } from '@/lib/governance/audit-export'
import { AuditExportError } from '@/lib/audit/export'
import { organizationSession } from '@/lib/enterprise/http'
import { defineRoute } from '@/lib/primitives/define-route'

type Context = { params: Promise<{ organizationId: string }> }
async function exported(work: () => Promise<unknown>) {
  try { return await work() }
  catch (error) {
    if (error instanceof AuditExportError) return Response.json({ error: { code: error.code } }, { status: error.status, headers: { 'cache-control': 'private, no-store' } })
    throw error
  }
}
const POSTBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId, true)
  const input = await governanceJson(request)
  return exported(() => createOrganizationAuditExport(organizationId, session.user.id, input))
}))
const GETBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const query = new URL(request.url).searchParams
  if (query.get('view') === 'events') {
    const session = await organizationSession(request, organizationId)
    query.delete('view')
    return exported(() => listOrganizationAuditEvents(organizationId, session.user.id, Object.fromEntries(query)))
  }
  const session = await organizationSession(request, organizationId, true)
  return exported(() => readOrganizationAuditExport(organizationId, session.user.id, query.get('exportId') ?? '', Number(query.get('offset') ?? 0), Number(query.get('limit') ?? 100)))
}))

export const POST = defineRoute<'public', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]/audit-log',
    auth: 'public',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => POSTBody(request, { params: Promise.resolve(params) }),
)

export const GET = defineRoute<'public', 'none', { organizationId: string }>(
  {
    route: '/api/organizations/[organizationId]/audit-log',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)
