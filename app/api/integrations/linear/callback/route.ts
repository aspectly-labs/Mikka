import { defineRoute } from '@/lib/primitives/define-route'

export const GET = defineRoute(
  {
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  () => Response.json({ disabled: true }, { status: 410 }),
)
