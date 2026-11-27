import { RouteResponse } from '@/lib/server-runtime/server'
import { readCoordinatorOverview } from '@/lib/coordinator/overview'
import { defineRoute } from '@/lib/primitives/define-route'

const headers = { 'Cache-Control': 'private, no-store' }

/** The Coordinator's overview: needs-you, in-flight runs and published PRs (#2935). */
export const GET = defineRoute<'session', 'pat-scoped'>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    workspaceId: ({ request }) => new URL(request.url).searchParams.get('workspaceId'),
    desktop: true,
  },
  async ({ request, user }) => {
    const workspaceId = new URL(request.url).searchParams.get('workspaceId') ?? undefined
    return RouteResponse.json(await readCoordinatorOverview(user, workspaceId), {
      headers: { ...headers, 'X-Mikka-Observed-At': new Date().toISOString(), 'X-Mikka-Viewer': user.id },
    })
  },
)
