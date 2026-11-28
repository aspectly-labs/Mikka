import { z } from 'zod'
import { reviewBatchRequest, WorkspaceReviewError } from '@mikka/protocol/coding-workspace-review'
import { reviewHttp } from '@/lib/coding-workspace/diff/http'
import { deliverAgentReview } from '@/lib/coding-workspace/diff/agent-delivery'
import { readReviewDeliveries, reviewDeliveryQuery } from '@/lib/coding-workspace/diff/delivery'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 30
const query = z.strictObject({ workspaceId: z.uuid().optional(), repoId: z.uuid(), batchId: z.uuid().optional(), cursor: z.string().max(1024).optional() })
const command = z.strictObject({ workspaceId: z.uuid().optional(), repoId: z.uuid(), mutation: reviewBatchRequest })

const reviewGet = reviewHttp(async ({ deps, actor, runId, repoId, snapshotId, input, request }) => {
  const value = query.parse(input)
  return readReviewDeliveries(deps, actor, runId, repoId, z.uuid().parse(snapshotId),
    reviewDeliveryQuery.parse({ batchId: value.batchId, cursor: value.cursor }), request.signal)
})

const reviewPost = reviewHttp(async ({ deps, actor, runId, repoId, snapshotId, input, request }) => {
  const value = command.parse(input)
  if (value.mutation.snapshotId !== snapshotId) throw new WorkspaceReviewError('workspace_snapshot_outdated')
  return { batch: await deliverAgentReview(deps, actor, runId, repoId, value.mutation, request.signal) }
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
