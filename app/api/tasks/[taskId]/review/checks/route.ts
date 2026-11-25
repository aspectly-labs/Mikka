import { taskReviewHttp } from '@/lib/coding-workspace/task-review/http'
import { readTaskReviewChecks } from '@/lib/coding-workspace/task-review/checks'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 30
const handler = taskReviewHttp(readTaskReviewChecks)

export const GET = defineRoute<'public','none',{ taskId: string }>(
  { route: '/api/tasks/[taskId]/review/checks', auth: 'public', origin: 'any', workspace: 'none' },
  ({ request, params }) => handler(request, { params: Promise.resolve(params) }),
)
