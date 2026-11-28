import { RouteResponse } from '@/lib/server-runtime/server'
import { resolveBillingCatalog } from '@/lib/billing/catalog'
import { defineRoute, NO_STORE_PRIVATE_HEADERS } from '@/lib/primitives/define-route'
import { loadWorkspaceContext } from '@/lib/workspace-access'

/** Authenticated workspace-scoped read of the server-side billing catalog. */
export const GET = defineRoute<'session', 'pat-scoped'>(
  {
    route: '/api/billing/catalog',
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    workspaceId: ({ request }) => new URL(request.url).searchParams.get('workspace'),
  },
  async ({ session, request, requestedWorkspaceId, assertWorkspaceAllowed }) => {
    const context = await loadWorkspaceContext(requestedWorkspaceId ?? undefined, session.user)
    assertWorkspaceAllowed(context.workspace.id)
    const includeE2BMachineSkus = new URL(request.url).searchParams.get('include') === 'e2b'
    const catalog = await resolveBillingCatalog({
      workspaceId: context.workspace.id,
      includeE2BMachineSkus,
    })
    return RouteResponse.json(catalog, { headers: NO_STORE_PRIVATE_HEADERS })
  },
)
