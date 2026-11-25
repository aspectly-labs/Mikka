import { handleEveProductRequest } from '@/lib/eve/product-gateway'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 300
export const POST = defineRoute<'public', 'none'>(
  {
    route: '/api/internal/eve/tools',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request }) => handleEveProductRequest(request),
)
