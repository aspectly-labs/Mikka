import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceResponse, governanceSession } from '@/lib/governance/http'
import { defineRoute } from '@/lib/primitives/define-route'
import { readDeviceSettingsDetail } from '@/lib/settings/device-detail'

const governanceDenied = () => Response.json(
  { error: { code: 'governance_denied', detail: 'access_denied' } },
  { status: 403, headers: { 'cache-control': 'private, no-store' } },
)

export const GET = freshSessionRoute(defineRoute<'session', 'none', { deviceId: string }>(
  { auth: 'session', origin: 'any', workspace: 'none', freshSession: true, onAuthFailure: governanceDenied },
  async ({ request, params }) => governanceResponse(async () => {
    const { deviceId } = params
    const workspaceId = z.uuid().parse(new URL(request.url).searchParams.get('workspaceId'))
    const session = await governanceSession(request, workspaceId)
    return readDeviceSettingsDetail(session.user, { workspaceId, deviceId })
  }),
))
