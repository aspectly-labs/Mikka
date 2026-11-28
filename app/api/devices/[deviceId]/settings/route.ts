import { patchDeviceConcurrency } from '@/app/actions/settings'
import { settingsBody, settingsResponse, settingsWorkspaceQuery } from '@/lib/settings/http'
import { freshSessionRoute } from '@/lib/fresh-session'
import { defineRoute } from '@/lib/primitives/define-route'

export const PATCH = freshSessionRoute(defineRoute<'session', 'none', { deviceId: string }>(
  { auth: 'session', origin: 'same-origin-or-desktop', workspace: 'none', freshSession: true, route: '/api/devices/[deviceId]/settings' },
  async ({ request, params }) =>
    settingsResponse(async () => patchDeviceConcurrency(params.deviceId, await settingsBody(request), settingsWorkspaceQuery(request))),
))
