import {withDeviceRoute} from '@/lib/device-route'
import {RouteResponse} from '@/lib/server-runtime/server'
import {authenticateDevice,ownsDevice} from '@/lib/device-link'

/** Old device messages authenticate normally, but cannot restart a retired
 * model job. Stored turns and tool-scope checks remain compatibility data. */
async function handlePOST(request:Request,{params}:{params:Promise<{deviceId:string}>}) {
  const caller=await authenticateDevice(request)
  if(!caller)return RouteResponse.json({error:'Unauthorized'},{status:401})
  const {deviceId}=await params
  if(!await ownsDevice(deviceId,caller.userId))return RouteResponse.json({error:'Unknown device.'},{status:404})
  return RouteResponse.json({error:'notEnabled'},{status:404})
}
export const POST=withDeviceRoute(handlePOST)
