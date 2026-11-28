import { reviewHttp, reviewPageQuery } from '@/lib/coding-workspace/diff/http'
import { diffPage } from '@/lib/coding-workspace/diff/service'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 30
const reviewGet = reviewHttp(async ({ deps, actor, runId, repoId, snapshotId, input, request }) => {
  const value = reviewPageQuery.parse(input)
  return diffPage(deps, actor, runId, repoId, { snapshotId, cursor: value.cursor, limit: value.limit, unreviewed: value.unreviewed === 'true' }, request.signal)
})
export const GET = defineRoute<'session', 'pat-scoped', { runId: string; snapshotId: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  ({ request, params }) => reviewGet(request, { params: Promise.resolve(params) }),
)
