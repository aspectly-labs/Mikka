import { taskReviewHttp } from '@/lib/coding-workspace/task-review/http'
import { markTaskReviewFiles } from '@/lib/coding-workspace/task-review/reviewed'
import { defineRoute } from '@/lib/primitives/define-route'

const handler = taskReviewHttp(markTaskReviewFiles)

export const POST = defineRoute<'public','none',{ taskId: string }>(
  { route: '/api/tasks/[taskId]/review/reviewed', auth: 'public', origin: 'any', workspace: 'none' },
  ({ request, params }) => handler(request, { params: Promise.resolve(params) }),
)
