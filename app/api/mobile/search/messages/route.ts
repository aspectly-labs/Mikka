import { SearchInputError } from '@/lib/issue-search'
import { json } from '@/lib/mobile-api'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'
import { parseMessageSearchInput } from '@/lib/mobile-message-search-contract'
import { MobileMessageSearchAccessError, searchMobileMessages } from '@/lib/mobile-message-search'
import { defineRoute } from '@/lib/primitives/define-route'
import type { ApiSession } from '@/lib/api-auth'

/**
 * `GET /api/mobile/search/messages?q=&workspaceId=&scope=all|bot|group|thread&botId=&conversationId=&limit=&cursor=`:
 * authorized full-text message search across Bot chats, group conversations,
 * and task/agent threads in one workspace.
 */
async function handleGET(request: Request, user: ApiSession['user']) {
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

export const GET = defineRoute<'mobile-or-session', 'pat-scoped'>(
  {
    route: '/api/mobile/search/messages',
    auth: 'mobile-or-session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  async ({ request, user }) => handleGET(request, user),
)
