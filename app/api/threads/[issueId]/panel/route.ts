import { RouteResponse } from '@/lib/server-runtime/server'
import { auth } from '@/lib/api-auth'
import { readThreadPanelState, threadPanelAccess, threadPanelStateSchema, writeThreadPanelState } from '@/lib/thread-panel'

const headers = { 'Cache-Control': 'private, no-store' }

type Context = { params: Promise<{ issueId: string }> }

function runIdParam(request: Request) {
  const runId = new URL(request.url).searchParams.get('runId')
  return runId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId) ? runId : null
}

/** The right column's per-thread layout ({tabs, active, open}), kept per viewer
 * and per thread (the chain's root run keys the row, #2935). */
export const GET = async (request: Request, { params }: Context) => {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return RouteResponse.json({ error: 'authRequired' }, { status: 401, headers })
  const [{ issueId }, runId] = await Promise.all([params, Promise.resolve(runIdParam(request))])
  if (!runId) return RouteResponse.json({ error: 'invalidInput' }, { status: 400, headers })
  const rootRunId = await threadPanelAccess(session.user, issueId, runId)
  if (!rootRunId) return RouteResponse.json({ error: 'threadNotFound' }, { status: 404, headers })
  return RouteResponse.json(await readThreadPanelState(session.user.id, rootRunId), { headers })
}

export const PUT = async (request: Request, { params }: Context) => {
  if (request.headers.get('origin') !== new URL(request.url).origin) return RouteResponse.json({ error: 'originMismatch' }, { status: 403, headers })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return RouteResponse.json({ error: 'authRequired' }, { status: 401, headers })
  const [{ issueId }, runId] = await Promise.all([params, Promise.resolve(runIdParam(request))])
  if (!runId) return RouteResponse.json({ error: 'invalidInput' }, { status: 400, headers })
  const parsed = threadPanelStateSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return RouteResponse.json({ error: 'invalidInput' }, { status: 400, headers })
  const rootRunId = await threadPanelAccess(session.user, issueId, runId)
  if (!rootRunId) return RouteResponse.json({ error: 'threadNotFound' }, { status: 404, headers })
  await writeThreadPanelState(session.user.id, rootRunId, parsed.data)
  return RouteResponse.json(parsed.data, { headers })
}
