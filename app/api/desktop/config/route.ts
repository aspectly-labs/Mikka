import { desktopConfig } from '@/lib/desktop-rpc/bootstrap'
import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute(
  { auth: 'public', origin: 'any', workspace: 'none', route: '/api/desktop/config' },
  async () => Response.json(await desktopConfig(), { headers: { 'Cache-Control': 'no-store' } }),
)
