import { RouteResponse } from '@/lib/server-runtime/server'
import { type ApiSession } from '@/lib/api-auth'
import { actAs } from '@/lib/acting-user'
import { ActionFailureError } from '@/lib/action-error'
import { db } from '@/lib/db'
import { parseSearchParams, searchIssues, SearchInputError } from '@/lib/issue-search'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'
import { defineRoute } from '@/lib/primitives/define-route'

/**
 * GET /api/issues/search — relation picker search (MIK-16). See lib/issue-search.ts for the
 * full contract. Query params:
 *   q                    '' = recent; ORV-123 / MIK-123 / 123 = exact number; else title match.
 *                        One non-CJK character is a 400; one CJK character searches.
 *   issueId              the issue being edited; drives existingRelation and canRelate.
 *   relationKind         optional; preferred kind when reporting existingRelation.
 *   excludeId            hidden from results (usually = issueId).
 *   excludeDescendants   also hide excludeId's descendants (recursive, 20-level cap).
 *   excludeAncestors     also hide excludeId's ancestors (recursive, 20-level cap).
 *   workspaceId          defaults to the current workspace.
 *   limit (1–50, default 20), cursor (opaque, from nextCursor).
 * Response: { items, nextCursor, truncated }. truncated = the ancestor/descendant walk hit the
 * 20-level cap, so some deeper relatives may not be excluded; nextCursor = more rows exist.
 */
async function unguardedGET(request: Request, session: ApiSession) {
  const userId = session.user.id
  try {
    const params = parseSearchParams(new URL(request.url).searchParams)
    const context = await loadWorkspaceContext(params.workspaceId ?? undefined, session.user)
    // Inside actAs, a workspace token's scope reaches the task visibility check.
    const result = await actAs(session.user, () => searchIssues(db, { userId, params, workspaceId: context.workspace.id }))
    return RouteResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof SearchInputError) return RouteResponse.json({ error: error.code }, { status: 400 })
    if (error instanceof WorkspaceError) return RouteResponse.json({ error: error.code }, { status: 403 })
    if (error instanceof ActionFailureError) return RouteResponse.json({ error: error.code }, { status: error.code === 'authRequired' ? 401 : 404 })
    if (error instanceof Error && error.name === 'ZodError') return RouteResponse.json({ error: 'searchInvalidParam' }, { status: 400 })
    console.error('Issue search failed', error instanceof Error ? error.name : 'UnknownError')
    return RouteResponse.json({ error: 'issueSearchFailed' }, { status: 500 })
  }
}
export const GET = defineRoute(
  {
    route: '/api/issues/search',
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    desktop: true,
  },
  ({ request, session }) => unguardedGET(request, session),
)
