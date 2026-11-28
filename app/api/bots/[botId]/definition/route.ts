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
const dependencies: Omit<Parameters<typeof createAgentDefinitionHandler>[0], 'authenticate'> = {
  enabled:agentKitEnabled,
  scope:async (ownerId,botId,request) => {
    const scope = await agentScope(ownerId,botId)
    const session = await auth.api.getSession({ headers:request.headers,query:{ disableCookieCache:true } })
    if (!session || session.user.id !== ownerId || (scope.workspaceId && !apiWorkspaceAllowed(session,scope.workspaceId))) throw new AgentKitError('agentScopeNotFound',404)
    return scope
  },store:agentKitStore,defaults:agentKitDefaults(),
  writePolicy: { enabled:personalWritesEnabled, settings:createWritePolicySettings(pool, scope => scope.workspaceId ? (_tx, signal) => acquireWorkspaceMembership(workspacePool, { workspaceId:scope.workspaceId!, userId:scope.ownerId }, signal) : undefined) },
  evaluate:(scope,proposalId,requestId,mode) => evaluateProposal(agentKitStore,scope,proposalId,requestId,mode),
}

// The route already read a database-fresh principal. Bind it only to this
// request; scope still rechecks session/PAT revocation after its database I/O.
const handler = (request: Request, botId: string, ownerId: string) =>
  createAgentDefinitionHandler({ ...dependencies, authenticate: async () => ownerId })(request, botId)

export const GET = defineRoute<'session', 'pat-scoped', { botId: string }>(
  { auth: 'session', origin: 'any', workspace: 'pat-scoped', freshSession: true },
  ({ request, params, user }) => handler(request, params.botId, user.id),
)
export const POST = defineRoute<'session', 'pat-scoped', { botId: string }>(
  { auth: 'session', origin: 'same-origin-or-desktop', workspace: 'pat-scoped', freshSession: true, write: true },
  ({ request, params, user }) => handler(request, params.botId, user.id),
)
