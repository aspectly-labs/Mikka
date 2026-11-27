import { taskReviewHttp } from '@/lib/coding-workspace/task-review/http'
import { readTaskReview } from '@/lib/coding-workspace/task-review/read'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 30
const handler = taskReviewHttp(readTaskReview)

export const GET = defineRoute<'public','none',{ taskId: string }>(
  { route: '/api/tasks/[taskId]/review', auth: 'public', origin: 'any', workspace: 'none' },
  ({ request, params }) => handler(request, { params: Promise.resolve(params) }),
)
