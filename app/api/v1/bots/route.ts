import { interopApi } from '@/lib/interop/http'
import { listInteropBots } from '@/lib/interop/bots'
import { defineRoute } from '@/lib/primitives/define-route'

/** Bots of the credential's Workspace it may discover (decision 2026-11-19-2200). */
const handleGET = (request: Request) => interopApi(request, 'bots:read', async principal => ({ bots: await listInteropBots(principal) }))

export const GET = defineRoute(
  {
    route: '/api/v1/bots',
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  async ({ request }) => handleGET(request),
)
