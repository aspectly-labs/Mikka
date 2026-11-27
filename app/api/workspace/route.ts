import { RouteResponse } from '@/lib/server-runtime/server'
import { getTranslations } from '@/lib/intl/i18n-server'
import type { ApiSession } from '@/lib/api-auth'
import { loadWorkspaceSettings, WorkspaceError } from '@/lib/workspace-access'
import { defineRoute } from '@/lib/primitives/define-route'
import { selectedWorkspaceId } from '@/lib/workspace-selection'

async function handleGET(request: Request, session: ApiSession) {
  const authenticated = performance.now()
  try {
    const data = await loadWorkspaceSettings(new URL(request.url).searchParams.get('workspace') ?? undefined, session.user)
    return RouteResponse.json(data, { headers: {
      'Cache-Control': 'private, no-store',
      'Server-Timing': `auth;dur=0.0, workspace;dur=${(performance.now() - authenticated).toFixed(1)}`,
    } })
  } catch (error) {
    if (error instanceof WorkspaceError) {
      const t = await getTranslations('Errors')
      return RouteResponse.json({ error: t.has(error.code as never) ? t(error.code as never) : error.message }, { status: 403 })
    }
    console.error('Workspace settings could not be loaded', error instanceof Error ? error.name : 'UnknownError')
    return RouteResponse.json({ error: 'workspaceReadFailed' }, { status: 500 })
  }
}

export const GET = defineRoute<'session', 'pat-scoped'>(
  {
    route: '/api/workspace',
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
    workspaceId: ({ request }) => selectedWorkspaceId(new URL(request.url).searchParams.get('workspace')) ?? undefined,
  },
  ({ request, session }) => handleGET(request, session),
)
