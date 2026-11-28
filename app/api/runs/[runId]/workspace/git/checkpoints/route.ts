import { listRunCheckpoints } from '@/lib/coding-workspace/git/service'
import { gitHttp } from '@/lib/coding-workspace/git/http'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 30

const gitGet = gitHttp(async ({ actor, runId, repoId, request }) => {
  return { value: await listRunCheckpoints({ database: pool, membership: workspacePool }, actor, runId, repoId, request.signal) }
})
export const GET = defineRoute<'session', 'pat-scoped', { runId: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  ({ request, params }) => gitGet(request, { params: Promise.resolve(params) }),
)
