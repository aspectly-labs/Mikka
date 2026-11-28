import { taskReviewHttp } from '@/lib/coding-workspace/task-review/http'
import { readTaskReviewFile } from '@/lib/coding-workspace/task-review/read'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 30
const handler = taskReviewHttp(readTaskReviewFile)

export const GET = defineRoute<'public','none',{ taskId: string }>(
  { route: '/api/tasks/[taskId]/review/file', auth: 'public', origin: 'any', workspace: 'none' },
  ({ request, params }) => handler(request, { params: Promise.resolve(params) }),
)
