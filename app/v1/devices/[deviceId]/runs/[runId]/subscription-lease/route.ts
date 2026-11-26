import { withDeviceRoute } from '@/lib/device-route'

// Older devices must upgrade to the run-bound model gateway. This route
// returns the same refusal for every caller and cannot open an OAuth grant.
export const POST = withDeviceRoute(async () => {
  return Response.json({ error: 'subscription_gateway_required' }, {
    status: 410,
    headers: { 'cache-control': 'private, no-store' },
  })
})
