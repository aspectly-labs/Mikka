import { RouteResponse } from '@/lib/server-runtime/server'
import { auth } from '@/lib/api-auth'
import { readCoordinatorOverview } from '@/lib/coordinator/overview'

const headers = { 'Cache-Control': 'private, no-store' }

/** The Coordinator's overview: needs-you, in-flight runs and published PRs (#2935). */
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return RouteResponse.json({ error: 'authRequired' }, { status: 401, headers })
  const workspaceId = new URL(request.url).searchParams.get('workspaceId') ?? undefined
  return RouteResponse.json(await readCoordinatorOverview(session.user, workspaceId), {
    headers: { ...headers, 'X-Mikka-Observed-At': new Date().toISOString(), 'X-Mikka-Viewer': session.user.id },
  })
}
