import { taskReviewHttp } from '@/lib/coding-workspace/task-review/http'
import { mergeTaskReview } from '@/lib/coding-workspace/task-review/merge'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 60
const handler = taskReviewHttp(mergeTaskReview)

export const POST = defineRoute<'public','none',{ taskId: string }>(
  { route: '/api/tasks/[taskId]/review/merge', auth: 'public', origin: 'any', workspace: 'none' },
  ({ request, params }) => handler(request, { params: Promise.resolve(params) }),
)
