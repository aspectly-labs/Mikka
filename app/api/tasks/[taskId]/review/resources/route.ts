import { taskReviewHttp } from '@/lib/coding-workspace/task-review/http'
import { readTaskReviewResources } from '@/lib/coding-workspace/task-review/resources'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 30
const handler = taskReviewHttp(readTaskReviewResources)

export const GET = defineRoute<'public','none',{ taskId: string }>(
  { route: '/api/tasks/[taskId]/review/resources', auth: 'public', origin: 'any', workspace: 'none' },
  ({ request, params }) => handler(request, { params: Promise.resolve(params) }),
)
