import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { SearchInputError } from '@/lib/issue-search'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'
import { parseMessageSearchInput } from '@/lib/mobile-message-search-contract'
import { MobileMessageSearchAccessError, searchMobileMessages } from '@/lib/mobile-message-search'

/**
 * `GET /api/mobile/search/messages?q=&workspaceId=&scope=all|bot|group|thread&botId=&conversationId=&limit=&cursor=`:
 * authorized full-text message search across Bot chats, group conversations,
 * and task/agent threads in one workspace.
 */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  try {
    const params = new URL(request.url).searchParams
    const explicitWorkspace = params.get('workspaceId')
    const defaultWorkspaceId = explicitWorkspace ?? (await loadWorkspaceContext(undefined, user)).workspace.id
    const input = parseMessageSearchInput(params, user.id, defaultWorkspaceId)
    return json(await searchMobileMessages(user, input))
  } catch (error) {
    if (error instanceof SearchInputError) return json({ error: error.code }, 400)
    if (error instanceof MobileMessageSearchAccessError || error instanceof WorkspaceError) {
      return json({ error: 'searchAccessDenied' }, 403)
    }
    throw error
  }
}

export const GET = withRequestLog('/api/mobile/search/messages', handleGET)
