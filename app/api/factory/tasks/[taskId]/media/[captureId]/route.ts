import { serveFactoryTaskMedia } from '@/lib/factory/task-media-route'
import { defineRoute } from '@/lib/primitives/define-route'

/** Any ready capture from this task's own runs, not only report references. */
export const GET = defineRoute(
  {
    route: '/api/factory/tasks/[taskId]/media/[captureId]',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
    desktop: true,
  },
  ({ request, params }) => serveFactoryTaskMedia(request, params.taskId, params.captureId),
)
