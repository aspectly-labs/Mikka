import { and, eq, isNull } from 'drizzle-orm'
import { freshSessionRoute } from '@/lib/fresh-session'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace } from '@/lib/workspace-access'
import { organizationMembers, organizations } from '@/lib/db/governance-schema'
import { workspaceGovernanceSummary } from '@/lib/governance/entitlements'
import { governanceResponse, governanceSession } from '@/lib/governance/http'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { defineRoute } from '@/lib/primitives/define-route'
type Context = { params: Promise<{ workspaceId: string }> }

const GETBody = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { workspaceId } = await context.params
  const session = await governanceSession(request, workspaceId)
  return workspaceDb.transaction(async tx => {
    const { membership } = await requireWorkspace(tx, workspaceId, session.user.id, false, session.user[enterprisePrincipal])
    const summary = await workspaceGovernanceSummary(tx, workspaceId)
    const canEdit = membership.role === 'admin'
    const ownedOrganizations = canEdit ? await tx.select({ id: organizations.id, name: organizations.name, role: organizationMembers.role }).from(organizations).innerJoin(organizationMembers, eq(organizationMembers.organizationId, organizations.id)).where(and(eq(organizationMembers.userId, session.user.id), eq(organizationMembers.status, 'active'), isNull(organizations.archivedAt))) : []
    // Approval templates are gone (ADR 2026-11-27-1615): agents run with full
    // access, so there is no CLI policy to template. `templates` stays empty
    // until the hosted settings page drops the section.
    return { ...summary, canEdit, templates: [], organizations: ownedOrganizations.filter(row => row.role !== 'member') }
  })
}))

export const GET = defineRoute<'public', 'none', { workspaceId: string }>(
  {
    route: '/api/workspaces/[workspaceId]/governance',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => GETBody(request, { params: Promise.resolve(params) }),
)

