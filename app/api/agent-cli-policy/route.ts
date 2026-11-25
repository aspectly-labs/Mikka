import { z } from 'zod'
import { pool } from '@/lib/db'
import { readCliAgentPolicy, readCliRunPolicy } from '@/lib/agent-tool-approval/policy-store'
import { setCliAgentPolicy, setCliPolicy } from '@/lib/agent-tool-approval/policy-settings'
import { defineRoute } from '@/lib/primitives/define-route'

const schema = z.discriminatedUnion('operation', [
  z.object({ operation:z.literal('read'), runId:z.uuid() }).strict(),
  z.object({ operation:z.literal('readAgent'), agentId:z.uuid(), botId:z.uuid().nullable() }).strict(),
  z.object({ operation:z.literal('setAgent'), agentId:z.uuid(), botId:z.uuid().nullable(), target:z.enum(['workspace']), expectedRevision:z.string().regex(/^[a-f0-9]{64}$/), policy:z.unknown() }).strict(),
  z.object({ operation:z.literal('set'), runId:z.uuid(), target:z.enum(['workspace','team','project']), expectedRevision:z.string().regex(/^[a-f0-9]{64}$/), policy:z.unknown() }).strict(),
])

const unauthorized = () => Response.json({ error: 'unauthorized' }, { status: 401 })

export const POST = defineRoute<'human-session-only', 'none'>(
  {
    auth: 'human-session-only',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
    onAuthFailure: unauthorized,
  },
  async ({ request, user }) => {
    // Preserve exact strict same-origin + 401 unauthorized contract for installed clients.
    if (request.headers.get('origin') !== new URL(request.url).origin) {
      return unauthorized()
    }
    const result = schema.safeParse(await request.json().catch(() => null))
    if (!result.success) return Response.json({ error:'invalidRequest' }, { status:400 })
    const body = result.data
    try {
      const value = body.operation === 'read' ? await readCliRunPolicy(pool,body.runId,user.id)
        : body.operation === 'set' ? await setCliPolicy(pool,user.id,body.runId,body.target,body.expectedRevision,body.policy)
        : body.operation === 'readAgent' ? await readCliAgentPolicy(pool,user.id,body.agentId,body.botId)
        : await setCliAgentPolicy(pool,user.id,body.agentId,body.botId,body.target,body.expectedRevision,body.policy)
      return Response.json(value, { headers:{ 'cache-control':'no-store' } })
    } catch { return Response.json({ error:'agentPolicyUnavailable' }, { status:409 }) }
  },
)
