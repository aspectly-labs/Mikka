import { RouteResponse } from '@/lib/server-runtime/server'
import { z } from 'zod'
import { runEvidence } from '@/lib/captures/store'
import { withBasePath } from '@/lib/base-path'
import { runOutsideToken } from '@/lib/tokens/scope'
import { defineRoute } from '@/lib/primitives/define-route'

/**
 * `GET /api/runs/:runId/evidence`: what one of the person's threads
 * produced, for acceptance: its screenshots and recordings and the
 * documents it handed over. Only the run's owner reads it (R-62).
 */
export const GET = defineRoute<'session', 'pat-scoped', { runId: string }>(
  { auth: 'session', origin: 'any', workspace: 'pat-scoped', desktop: true },
  async ({ request, params, user }) => {
    const headers = { 'cache-control': 'private, no-store' }
    const found = z.uuid().safeParse(params.runId).success && !await runOutsideToken(user, params.runId)
      ? await runEvidence(user.id, params.runId) : null
    if (!found) return RouteResponse.json({ error: 'Not found' }, { status: 404, headers })
    let bootstrap: unknown
    const query = new URL(request.url).searchParams
    if (query.has('bootstrap')) {
      const { bootstrapEvidenceQuery, readRunBootstrapEvidence } = await import('@/lib/captures/bootstrap-evidence')
      const parsed = bootstrapEvidenceQuery.safeParse(Object.fromEntries(query))
      if (!parsed.success || [...query.keys()].length !== Object.keys(parsed.data).length)
        return RouteResponse.json({ error: 'Invalid bootstrap evidence request' }, { status: 400, headers })
      const { pool } = await import('@/lib/db')
      bootstrap = await readRunBootstrapEvidence(pool, user.id, params.runId, parsed.data)
      if (!bootstrap) return RouteResponse.json({ error: 'Not found' }, { status: 404, headers })
    }
    return RouteResponse.json({
      ...found,
      ...(bootstrap ? { bootstrap } : {}),
      captures: found.captures.map(capture => ({ ...capture, url: withBasePath(`/api/captures/${capture.id}`) })),
      artifacts: found.artifacts.map(artifact => ({ ...artifact, url: withBasePath(`/api/artifacts/${artifact.id}/versions/${artifact.latestVersion}/download`) })),
    }, { headers })
  },
)
