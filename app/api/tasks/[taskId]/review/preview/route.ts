import { reviewPreviewRoute } from '@/lib/coding-workspace/preview/route'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 60

export const GET = defineRoute(
  { route: '/api/tasks/[taskId]/review/preview', auth: 'public', origin: 'any', workspace: 'none' },
  ({ request, params }) => reviewPreviewRoute(request, params.taskId),
)
