import { cloudComputerRunsEnabled } from '@/lib/cloud-computer-flag'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { WorkspaceError } from '@/lib/workspace-error'
import { sameOriginMutationAllowed, workspaceErrorStatus } from '@/lib/http-security'
import { defineRoute } from '@/lib/primitives/define-route'
import { bindBotSubscription } from '@/lib/computer/bot-subscription'

const inputSchema = z.object({ connectionId: z.uuid(), revision: z.number().int().positive(), harness: z.enum(['codex', 'claude_code']), modelId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) }).strict()
const headers = { 'Cache-Control': 'private, no-store' }
export const POST = defineRoute<'session', 'none', { botId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'none',
  },
  async ({ request, session, params }) => {
    if (!cloudComputerRunsEnabled()) return Response.json({ error: 'Cloud computer task unavailable' }, { status: 503, headers })
    if (!sameOriginMutationAllowed(request)) return Response.json({ error: 'Invalid origin' }, { status: 403, headers })
    const { botId } = params
    const requestId = request.headers.get('idempotency-key')
    const raw = await request.text()
    if (raw.length > 2000 || !z.uuid().safeParse(botId).success || (requestId && !z.uuid().safeParse(requestId).success)) return Response.json({ error: 'Invalid request' }, { status: 400, headers })
    const parsed = inputSchema.safeParse((() => { try { return JSON.parse(raw) } catch { return null } })())
    if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400, headers })
    try {
      const context = await loadWorkspaceContext(undefined, session.user)
      const result = await bindBotSubscription(pool, { userId: session.user.id, workspaceId: context.workspace.id }, { ...parsed.data, botId, ...(requestId ? { idempotencyKey: `api:${requestId}` } : {}) })
      return Response.json(result, { headers })
    } catch (error) {
      if (error instanceof WorkspaceError) return Response.json({ error: error.code }, { status: workspaceErrorStatus(error), headers })
      return Response.json({ error: 'Subscription unavailable' }, { status: 409, headers })
    }
  },
)
