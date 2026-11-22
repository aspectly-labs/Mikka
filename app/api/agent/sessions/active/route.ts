import { defaultAgentCopy as agentCopy } from '@/lib/agent-copy'
import { auth } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { activeAgentsResponse, isConversationUserMember, listActiveAgents } from '@/lib/active-agents'

/** The agents (and Coordinator) working for the signed-in person right now. */
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  return activeAgentsResponse(request, session?.user?.id ?? null, userId => listActiveAgents(db, userId, undefined, session?.tokenWorkspaceId), {
    pleaseSignIn: agentCopy.pleaseSignInFirst,
    unavailable: agentCopy.unableToLoadChatHistoryPleaseTry,
    noParameters: agentCopy.activeAgentsNoParameters,
    groupNotFound: agentCopy.activeAgentsGroupNotFound,
  }, {
    member: (userId, conversationId) => isConversationUserMember(db, conversationId, userId),
    list: (userId, conversationId) => listActiveAgents(db, userId, undefined, session?.tokenWorkspaceId, conversationId),
  })
}
