import { RouteResponse } from '@/lib/server-runtime/server'
import { defineRoute } from '@/lib/primitives/define-route'
import { readThreadPanelState, threadPanelAccess, threadPanelStateSchema, writeThreadPanelState } from '@/lib/thread-panel'

const headers = { 'Cache-Control': 'private, no-store' }

type P = { issueId: string }
function runIdParam(request: Request) {
  const runId = new URL(request.url).searchParams.get('runId')
  return runId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId) ? runId : null
}

/** The right column's per-thread layout ({tabs, active, open}), kept per viewer
 * and per thread (the chain's root run keys the row, #2935). */
export const GET = defineRoute<'session', 'pat-scoped', P>(
  { auth: 'session', origin: 'any', workspace: 'pat-scoped' },
  async ({ request, params, user }) => {
    const runId = runIdParam(request)
    if (!runId) return RouteResponse.json({ error: 'invalidInput' }, { status: 400, headers })
    const rootRunId = await threadPanelAccess(user, params.issueId, runId)
    if (!rootRunId) return RouteResponse.json({ error: 'threadNotFound' }, { status: 404, headers })
    return RouteResponse.json(await readThreadPanelState(user.id, rootRunId), { headers })
  },
)

export const PUT = defineRoute<'session', 'pat-scoped', P>(
  { auth: 'session', origin: 'same-origin-or-desktop', workspace: 'pat-scoped', write: true },
  async ({ request, params, user }) => {
    if (request.headers.get('origin') !== new URL(request.url).origin) return RouteResponse.json({ error: 'originMismatch' }, { status: 403, headers })
    const runId = runIdParam(request)
    if (!runId) return RouteResponse.json({ error: 'invalidInput' }, { status: 400, headers })
    const parsed = threadPanelStateSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return RouteResponse.json({ error: 'invalidInput' }, { status: 400, headers })
    const rootRunId = await threadPanelAccess(user, params.issueId, runId)
    if (!rootRunId) return RouteResponse.json({ error: 'threadNotFound' }, { status: 404, headers })
    await writeThreadPanelState(user.id, rootRunId, parsed.data)
    return RouteResponse.json(parsed.data, { headers })
  },
)
