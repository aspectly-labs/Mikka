import { getSettingsSchema } from '@/app/actions/settings'
import { settingsResponse } from '@/lib/settings/http'
import { withRequestLog } from '@/lib/request-log'
import { defineRoute } from '@/lib/primitives/define-route'

const GETBody = withRequestLog('/api/settings/schema', () => settingsResponse(getSettingsSchema))

export const GET = defineRoute<'session', 'none'>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'none',
  },
  ({ request }) => GETBody(request),
)
