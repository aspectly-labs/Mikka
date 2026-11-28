import { taskReviewHttp } from '@/lib/coding-workspace/task-review/http'
import { readTaskReviewSummary } from '@/lib/coding-workspace/task-review/read'
import { defineRoute } from '@/lib/primitives/define-route'

const handler = taskReviewHttp(readTaskReviewSummary)

export const GET = defineRoute<'public','none',{ taskId: string }>(
  { route: '/api/tasks/[taskId]/review/summary', auth: 'public', origin: 'any', workspace: 'none' },
  ({ request, params }) => handler(request, { params: Promise.resolve(params) }),
)
