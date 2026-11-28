import { pool } from '@/lib/db'
import { threadFilesRoute } from '@/lib/cloud-computer/thread-files'
import { defineRoute } from '@/lib/primitives/define-route'
export const maxDuration = 60

/** The Files tab's「This thread」projection (#2940). */
export const GET = defineRoute<'session', 'pat-scoped', { runId: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  ({ request, params }) => threadFilesRoute(request, pool, params.runId),
)
