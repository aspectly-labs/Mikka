import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { LIVE_ID } from '@/lib/live/events'
import { computerEventCursor } from '@/lib/computer/event-page'
import { readComputerEvents } from '@/lib/computer/event-log'
import { defineRoute } from '@/lib/primitives/define-route'

const headers = { 'cache-control': 'private, no-store' }

/** Browser notifications contain no data; each incremental read authorizes again. */
export const GET = defineRoute<'human-session-only', 'none'>(
  {
    route: '/api/computer/events',
    auth: 'human-session-only',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
    onAuthFailure: () => new Response(null, { status: 401, headers }),
  },
  async ({ request, user }) => {
    const params = new URL(request.url).searchParams
    const workspaceId = params.get('workspace') ?? ''
    const cursor = computerEventCursor(params.get('after') ?? '0')
    if (!LIVE_ID.test(workspaceId) || cursor === null) return new Response(null, { status: 400, headers })
    const member = await workspacePool.query(
      `SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active'`,
      [workspaceId, user.id],
    )
    if (!member.rowCount) return new Response(null, { status: 403, headers })
    const page = await readComputerEvents(pool, { ownerId: user.id, workspaceId }, cursor)
    return Response.json(page, { headers })
  },
)
