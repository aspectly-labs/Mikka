import { z } from 'zod'
import { githubReviewQuery, githubReviewMutation } from '@mikka/protocol/coding-workspace-review'
import { reviewHttp } from '@/lib/coding-workspace/diff/http'
import { readGitHubReview } from '@/lib/coding-workspace/diff/github-native'
import { deliverGitHubReview } from '@/lib/coding-workspace/diff/github-delivery'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 30
const query = githubReviewQuery.extend({ workspaceId: z.uuid().optional(), repoId: z.uuid() })
const command = z.strictObject({ workspaceId: z.uuid().optional(), repoId: z.uuid(), mutation: githubReviewMutation })

const reviewGet = reviewHttp(async ({ deps, actor, runId, repoId, snapshotId, input, request }) => {
  const value = query.parse(input)
  return { review: await readGitHubReview(deps, actor, runId, repoId, z.uuid().parse(snapshotId),
    { cursor: value.cursor, threadId: value.threadId }, request.signal) }
}, { nativeReview: true })

const reviewPost = reviewHttp(async ({ deps, actor, runId, repoId, snapshotId, input, request }) => {
  const value = command.parse(input)
  return { batch: await deliverGitHubReview(deps, actor, runId, repoId, z.uuid().parse(snapshotId), value.mutation, request.signal) }
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
