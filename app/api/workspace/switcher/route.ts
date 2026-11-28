import { withRequestLog } from '@/lib/request-log'
import { getTranslations } from '@/lib/intl/i18n-server'
import { RouteResponse } from '@/lib/server-runtime/server'
import { getApiSession } from '@/lib/api-auth'
import { loadWorkspaceSwitcher } from '@/lib/workspace-switcher'
import { WorkspaceError } from '@/lib/workspace-error'
import { defineRoute } from '@/lib/primitives/define-route'

async function handleGET(request: Request) {
  const i18nText = await getTranslations();
  try {
    const session = await getApiSession({ headers: request.headers })
    if (!session?.user) return RouteResponse.json({ error: 'authRequired' }, { status: 401 })
    return RouteResponse.json(await loadWorkspaceSwitcher(session), { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof WorkspaceError) {
      return RouteResponse.json({ error: i18nText("FeatureCopy.c_6a0f7116") }, { status: 403, headers: { 'Cache-Control': 'private, no-store' } })
    }
    console.error('Workspace switcher could not be loaded', error instanceof Error ? error.name : 'UnknownError')
    return RouteResponse.json({ error: 'workspaceReadFailed' }, { status: 500, headers: { 'Cache-Control': 'private, no-store' } })
  }
}

const GETBody = withRequestLog('/api/workspace/switcher', handleGET)

export const GET = defineRoute<'public', 'none'>(
  {
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  ({ request }) => GETBody(request),
)
