import { listRunGitHistory } from '@/lib/coding-workspace/git/service'
import { gitHttp, gitPagination } from '@/lib/coding-workspace/git/http'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 30

const gitGet = gitHttp(async ({ actor, input, runId, repoId, request }) => {
  const query = gitPagination.parse(input)
  const result = await listRunGitHistory({ database: pool, membership: workspacePool }, actor, runId, repoId,
    { cursor: query.cursor, limit: query.limit ?? 30 }, request.signal)
  return { value: result.value, live: result.live }
})
export const GET = defineRoute<'session', 'pat-scoped', { runId: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  ({ request, params }) => gitGet(request, { params: Promise.resolve(params) }),
)
