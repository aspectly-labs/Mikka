import { pool } from '@/lib/db'
import { listDispatchableDevices } from '@/lib/devices/dispatchable'
import { isPatSession } from '@/lib/http-security'
import { defineRoute } from '@/lib/primitives/define-route'

const headers = { 'Cache-Control': 'private, no-store' }

export const GET = defineRoute(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'none',
    desktop: true,
  },
  async ({ request, session }) => {
    if (request.headers.get('sec-fetch-site') === 'cross-site') return Response.json({ items: [] }, { status: 401, headers })
    if (isPatSession(session)) return Response.json({ error: 'sessionRequired', items: [] }, { status: 403, headers })
    return Response.json({ items: await listDispatchableDevices(pool.query.bind(pool), session.user.id) }, { headers })
  },
)
