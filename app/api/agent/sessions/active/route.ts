import { defaultAgentCopy as agentCopy } from '@/lib/agent-copy'
import { db } from '@/lib/db'
import { activeAgentsResponse, isConversationUserMember, listActiveAgents } from '@/lib/active-agents'
import { defineRoute } from '@/lib/primitives/define-route'

/** The agents (and Coordinator) working for the signed-in person right now. */
export const GET = defineRoute<'session', 'pat-scoped'>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    desktop: true,
  },
  ({ request, session, user }) => activeAgentsResponse(request, user.id, userId => listActiveAgents(db, userId, undefined, session.tokenWorkspaceId), {
    pleaseSignIn: agentCopy.pleaseSignInFirst,
    unavailable: agentCopy.unableToLoadChatHistoryPleaseTry,
    noParameters: agentCopy.activeAgentsNoParameters,
    groupNotFound: agentCopy.activeAgentsGroupNotFound,
  }, {
    member: (userId, conversationId) => isConversationUserMember(db, conversationId, userId, session.tokenWorkspaceId),
    list: (userId, conversationId) => listActiveAgents(db, userId, undefined, session.tokenWorkspaceId, conversationId),
  }),
)
