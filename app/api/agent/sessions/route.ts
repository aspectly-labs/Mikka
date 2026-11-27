import { defaultAgentCopy as agentCopy } from '@/lib/agent-copy'
import { z } from 'zod'
import { AgentStoreError, getAgentHistory } from '@/lib/agent-store'
import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute<'session', 'none'>(
  {
    route: '/api/agent/sessions',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
    desktop: true,
  },
  async ({ request, session }) => {
    const headers = { 'Cache-Control': 'private, no-store' }
    const params = new URL(request.url).searchParams
    const id = params.get('sessionId')
    if (id && !z.uuid().safeParse(id).success) return Response.json({ error: agentCopy.invalidConversationID }, { status: 400, headers })
    try {
      return Response.json(await getAgentHistory(session.user.id, id ?? undefined, params.get('new') === '1'), { headers })
    } catch (error) {
      return Response.json({ error: error instanceof AgentStoreError ? error.message : agentCopy.unableToLoadChatHistoryPleaseTry }, {
        status: error instanceof AgentStoreError ? error.status : 503, headers,
      })
    }
  },
)
