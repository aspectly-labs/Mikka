import { taskReviewHttp } from '@/lib/coding-workspace/task-review/http'
import { sendTaskReview } from '@/lib/coding-workspace/task-review/send'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 60
const handler = taskReviewHttp(sendTaskReview)

export const POST = defineRoute<'public','none',{ taskId: string }>(
  { route: '/api/tasks/[taskId]/review/send', auth: 'public', origin: 'any', workspace: 'none' },
  ({ request, params }) => handler(request, { params: Promise.resolve(params) }),
)
