import { withDeviceRoute } from '@/lib/device-route'
import { RouteResponse } from '@/lib/server-runtime/server'
import { authenticateDevice, ownsDevice } from '@/lib/device-link'
import { noteLogOutcome, withRequestLog } from '@/lib/request-log'


/**
 * `GET /v1/devices/:deviceId/fs/requests`: folder-browse requests queued for
 * this device. This app adds repositories by path, so the answer is always
 * empty and there is nothing to wait for.
 */
async function handleGET(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return RouteResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  if (!await ownsDevice(deviceId, caller.userId)) return RouteResponse.json({ error: 'Unknown device.' }, { status: 404 })
  noteLogOutcome('empty')
  return RouteResponse.json({ requests: [] })
}

export const GET = withRequestLog('/v1/devices/[deviceId]/fs/requests', withDeviceRoute(handleGET))
