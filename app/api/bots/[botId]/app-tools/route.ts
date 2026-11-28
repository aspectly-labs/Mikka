import { AgentKitError } from '@/lib/agent-kit/store'
import { agentScope } from '@/lib/agent-kit/service'
import { readAppToolCatalogue } from '@/lib/app-tool-catalogue'
import { defineRoute } from '@/lib/primitives/define-route'

const APP = /^[a-z][a-z0-9_]{0,63}$/

/** One Bot's connected app, as the provider actually lists its tools. Read-only; no credential leaves the server. */
export const GET = defineRoute<'human-session-only', 'none', { botId: string }>(
  {
    auth: 'human-session-only',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  async ({ request, params, user }) => {
    try {
      await agentScope(user.id, params.botId)
    } catch (error) {
      if (error instanceof AgentKitError) return Response.json({ error: error.code }, { status: error.status })
      return Response.json({ error: 'agentScopeUnavailable' }, { status: 503 })
    }
    const app = new URL(request.url).searchParams.get('app') ?? ''
    if (!APP.test(app)) return Response.json({ error: 'invalidApp' }, { status: 400 })
    try {
      return Response.json(await readAppToolCatalogue(user.id, app), {
        headers: { 'cache-control': 'private, max-age=60' },
      })
    } catch {
      return Response.json({ error: 'catalogueUnavailable' }, { status: 502 })
    }
  },
)
