import { handleModelGateway } from '@/lib/model-gateway/handler'
import { defineRoute } from '@/lib/primitives/define-route'


/** The Mikka model gateway (decision 2026-11-15-2000): authenticated by the run's own gateway token, not a session. */
async function handlePOST(request: Request) {
  return handleModelGateway(request, 'openai', 'responses')
}

export const POST = defineRoute(
  {
    route: '/api/model-gateway/openai/v1/responses',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request }) => handlePOST(request),
)
