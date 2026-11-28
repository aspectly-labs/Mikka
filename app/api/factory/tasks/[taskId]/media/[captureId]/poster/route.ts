import { serveFactoryTaskMedia } from '@/lib/factory/task-media-route'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 30

/** A private real-frame JPEG, generated once for new and historical videos. */
export const GET = defineRoute(
  {
    route: '/api/factory/tasks/[taskId]/media/[captureId]/poster',
    auth: 'session',
    origin: 'any',
    workspace: 'none',
    freshSession: true,
  },
  ({ request, params }) => serveFactoryTaskMedia(request, params.taskId, params.captureId, true),
)
