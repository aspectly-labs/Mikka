import 'server-only'
import { apiWorkspaceAllowed, type ApiSession } from '@/lib/api-auth'
import { billingManagementView, mutateBillingManagement } from '@/lib/billing/management'
import type { BillingManagementView, BillingScope } from '@/lib/billing/management-contract'
import { requireEnterpriseOrganization } from '@/lib/enterprise/access'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { listOrganizations } from '@/lib/governance/organizations'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'
import type { MobileBillingGetQuery } from './mobile-billing-contract'

export interface MobileBillingReadResult {
  available: boolean
  billingScope: BillingScope | null
  view: BillingManagementView | null
}

/**
 * Resolves the caller's effective billing scope using the exact rule
 * `GET /api/mobile/settings` advertises (`billingScope`), then applies the
 * same PAT workspace fence and enterprise organization gate as
 * `lib/billing/management-http.ts`.
 */
export async function resolveMobileBillingScope(
  session: ApiSession,
  explicitScope: BillingScope | null,
): Promise<BillingScope | null> {
  let scope = explicitScope
  if (!scope) {
    const context = await loadWorkspaceContext(undefined, session.user)
    if (context.role === 'admin') {
      scope = { kind: 'workspace', id: context.workspace.id }
    } else if (!session.tokenWorkspaceId) {
      const org = (await listOrganizations(session.user.id)).find(
        item => item.role === 'owner' || item.role === 'admin',
      )
      scope = org ? { kind: 'organization', id: org.id } : null
    }
  }
  if (!scope) return null

  if (scope.kind === 'workspace' ? !apiWorkspaceAllowed(session, scope.id) : Boolean(session.tokenWorkspaceId)) {
    throw new WorkspaceError('workspaceAccessDenied')
  }
  if (scope.kind === 'organization') {
    await requireEnterpriseOrganization(session.user.id, scope.id, session.session.id)
  }
  return scope
}

/** Single authorized billing reader for mobile Settings › Billing. */
export async function readMobileBilling(
  session: ApiSession,
  query: MobileBillingGetQuery,
): Promise<MobileBillingReadResult> {
  const scope = await resolveMobileBillingScope(session, query.scope)
  if (!scope) return { available: false, billingScope: null, view: null }
  const view = await billingManagementView(
    session.user.id,
    scope,
    query.budgetWorkspace,
    session.user[enterprisePrincipal],
    query.usageMember,
  )
  return { available: true, billingScope: scope, view }
}

/** Single authorized billing writer for mobile Settings › Billing (checkout, portal, topup, budget, recharge, account). */
export async function runMobileBillingMutation(
  session: ApiSession,
  explicitScope: BillingScope | null,
  operation: Record<string, unknown>,
) {
  const scope = await resolveMobileBillingScope(session, explicitScope)
  if (!scope) throw new WorkspaceError('workspaceAccessDenied')
  return mutateBillingManagement(session.user.id, scope, operation, session.user[enterprisePrincipal])
}
