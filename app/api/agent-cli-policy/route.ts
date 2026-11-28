import { z } from 'zod'
import { pool } from '@/lib/db'
import { readCliRunPolicy } from '@/lib/agent-tool-approval/policy-store'
import { defineRoute } from '@/lib/primitives/define-route'

// Reads a run's effective policy. There is nothing to configure: agents run
// with full access (ADR 2026-11-27-1615), so the former workspace, team,
// project and Agent policy writes (`set`, `setAgent`, `readAgent`) are gone.
const schema = z.object({ operation:z.literal('read'), runId:z.uuid() }).strict()

const unauthorized = () => Response.json({ error: 'unauthorized' }, { status: 401 })

export const POST = defineRoute<'human-session-only', 'none'>(
  {
    auth: 'human-session-only',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
    freshSession: true,
    write: true,
    onOriginFailure: unauthorized,
    onAuthFailure: unauthorized,
  },
  async ({ request, user }) => {
    // Reject omitted Origin as well while preserving the established 401 unauthorized contract.
    if (request.headers.get('origin') !== new URL(request.url).origin) {
      return unauthorized()
    }
    const result = schema.safeParse(await request.json().catch(() => null))
    if (!result.success) return Response.json({ error:'invalidRequest' }, { status:400 })
    const body = result.data
    try {
      const value = await readCliRunPolicy(pool,body.runId,user.id)
      return Response.json(value, { headers:{ 'cache-control':'no-store' } })
    } catch { return Response.json({ error:'agentPolicyUnavailable' }, { status:409 }) }
  },
)
