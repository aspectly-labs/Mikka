import { z } from 'zod'
import { reviewMutation } from '@mikka/protocol/coding-workspace-review'
import { reviewHttp } from '@/lib/coding-workspace/diff/http'
import { mutateReview, readReviewBoard } from '@/lib/coding-workspace/diff/review'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 30
const query = z.strictObject({ workspaceId: z.uuid().optional(), repoId: z.uuid(), cursor: z.string().max(4096).optional() })
const command = z.strictObject({ workspaceId: z.uuid().optional(), repoId: z.uuid(), mutation: reviewMutation })
const reviewGet = reviewHttp(async ({ deps, actor, runId, repoId, snapshotId, input }) => {
  const value = query.parse(input)
  return readReviewBoard(deps, actor, runId, repoId, z.uuid().parse(snapshotId), value.cursor)
})
const reviewPost = reviewHttp(async ({ deps, actor, runId, repoId, snapshotId, input, request }) => {
  const value = command.parse(input)
  return mutateReview(deps, actor, runId, repoId, z.uuid().parse(snapshotId), value.mutation, request.signal)
})
export const GET = defineRoute<'session', 'pat-scoped', { runId: string; snapshotId: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  ({ request, params }) => reviewGet(request, { params: Promise.resolve(params) }),
)

export const POST = defineRoute<'session', 'pat-scoped', { runId: string; snapshotId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    write: true,
  },
  ({ request, params }) => reviewPost(request, { params: Promise.resolve(params) }),
)
