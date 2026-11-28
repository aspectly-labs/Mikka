import { withDeviceRoute } from '@/lib/device-route'
import { RouteResponse } from '@/lib/server-runtime/server'
import { authenticateDevice, ownsDevice } from '@/lib/device-link'


/** `POST /v1/devices/:deviceId/fs/requests/:requestId`: the daemon's answer. */
async function handlePOST(request: Request, { params }: { params: Promise<{ deviceId: string; requestId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return RouteResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  if (!await ownsDevice(deviceId, caller.userId)) return RouteResponse.json({ error: 'Unknown device.' }, { status: 404 })
  return new RouteResponse(null, { status: 204 })
}

export const POST = withDeviceRoute(handlePOST)
