import { defineRoute } from '@/lib/primitives/define-route'

/** SSH belongs to the desktop main process. The browser uses daemon commands. */
export const POST = defineRoute(
  { auth: 'public', origin: 'any', workspace: 'none' },
  () => Response.json({ error: 'SSH installation requires the desktop app.' }, { status: 410 }),
)
