import { json } from '@/lib/mobile-api'
import { readMobileProactiveCards } from '@/lib/mobile-proactive-cards'
import { WorkspaceError } from '@/lib/workspace-error'
import { defineRoute } from '@/lib/primitives/define-route'
import type { ApiSession } from '@/lib/api-auth'

/**
 * `GET /api/mobile/proactive-cards`: Coordinator proactive cards for mobile
 * (today's briefing summary, pending external write proposals, and active
 * suggestions / in-progress handoffs). Pass `?readonly=1` for side-effect-free
 * background/count checks.
 */
async function handleGET(request: Request, user: ApiSession['user']) {
  const params = new URL(request.url).searchParams
  try {
    return json(
      await readMobileProactiveCards(user, {
        timeZone: params.get('tz'),
        ipTimeZone: request.headers.get('x-vercel-ip-timezone'),
        locale: params.get('locale'),
        readonly: params.get('readonly') === '1',
      }),
    )
  } catch (error) {
    if (error instanceof WorkspaceError) {
      return json(
        { error: error.code === 'workspaceAccessDenied' ? 'workspaceAccessDenied' : error.code },
        error.code === 'workspaceAccessDenied' ? 403 : 409,
      )
    }
    throw error
  }
}

export const GET = defineRoute<'mobile-or-session', 'pat-scoped'>(
  {
    route: '/api/mobile/proactive-cards',
    auth: 'mobile-or-session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  async ({ request, user }) => handleGET(request, user),
)
