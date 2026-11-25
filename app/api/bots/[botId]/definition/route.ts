import { auth, apiWorkspaceAllowed } from '@/lib/api-auth'
import { AgentKitError } from '@/lib/agent-kit/store'
import { createAgentDefinitionHandler } from '@/lib/agent-kit/http'
import { agentKitEnabled,agentKitStore,agentScope,agentKitDefaults } from '@/lib/agent-kit/service'
import { evaluateProposal } from '@/lib/agent-kit/live-eval'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { acquireWorkspaceMembership } from '@/lib/workspace-membership-guard'
import { createWritePolicySettings } from '@/lib/operations/write-policy-settings'
import { personalWritesEnabled } from '@/lib/operations/write-feature'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration=300
const handler=createAgentDefinitionHandler({
  enabled:agentKitEnabled,
  authenticate:async request => (await auth.api.getSession({ headers:request.headers,query:{ disableCookieCache:true } }))?.user.id ?? null,
  scope:async (ownerId,botId,request) => {
    const scope = await agentScope(ownerId,botId)
    const session = await auth.api.getSession({ headers:request.headers,query:{ disableCookieCache:true } })
    if (!session || session.user.id !== ownerId || (scope.workspaceId && !apiWorkspaceAllowed(session,scope.workspaceId))) throw new AgentKitError('agentScopeNotFound',404)
    return scope
  },store:agentKitStore,defaults:agentKitDefaults(),
  writePolicy: { enabled:personalWritesEnabled, settings:createWritePolicySettings(pool, scope => scope.workspaceId ? (_tx, signal) => acquireWorkspaceMembership(workspacePool, { workspaceId:scope.workspaceId!, userId:scope.ownerId }, signal) : undefined) },
  evaluate:(scope,proposalId,requestId,mode) => evaluateProposal(agentKitStore,scope,proposalId,requestId,mode),
})

export const GET = defineRoute<'session', 'pat-scoped', { botId: string }>(
  { auth: 'session', origin: 'any', workspace: 'pat-scoped', freshSession: true },
  ({ request, params }) => handler(request, params.botId),
)
export const POST = defineRoute<'session', 'pat-scoped', { botId: string }>(
  { auth: 'session', origin: 'same-origin-or-desktop', workspace: 'pat-scoped', freshSession: true, write: true },
  ({ request, params }) => handler(request, params.botId),
)
