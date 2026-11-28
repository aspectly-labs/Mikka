import { withDeviceRoute } from '@/lib/device-route'

// Older devices must upgrade to the run-bound model gateway. This route
// returns the same refusal for every authenticated caller and cannot open an OAuth grant.
export const POST = withDeviceRoute(async (_request, _context: { params: Promise<{ deviceId: string; runId: string }> }) => {
  return Response.json({ error: 'subscription_gateway_required' }, {
    status: 410,
    headers: { 'cache-control': 'private, no-store' },
  })
})
