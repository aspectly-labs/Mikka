// Older devices must upgrade to the run-bound model gateway. This route
// returns the same refusal for every caller and cannot open an OAuth grant.
export async function POST() {
  return Response.json({ error: 'subscription_gateway_required' }, {
    status: 410,
    headers: { 'cache-control': 'private, no-store' },
  })
}
