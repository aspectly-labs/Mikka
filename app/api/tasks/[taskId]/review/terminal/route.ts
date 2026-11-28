import { withRequestLog } from '@/lib/request-log'
import { reviewTerminal } from '@/lib/coding-workspace/terminal/http'
import { defineRoute } from '@/lib/primitives/define-route'

export const maxDuration = 300

const unguardedGET = withRequestLog('/api/tasks/[taskId]/review/terminal', async (request, { params }: { params: Promise<{ taskId: string }> }) =>
  reviewTerminal.stream(request, (await params).taskId))
const unguardedDELETE = withRequestLog('/api/tasks/[taskId]/review/terminal', async (request, { params }: { params: Promise<{ taskId: string }> }) =>
  reviewTerminal.close(request, (await params).taskId))
export const GET = defineRoute<'public','none',{ taskId: string }>(
  {
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  ({ request, params }) => unguardedGET(request, { params: Promise.resolve(params) }),
)

export const DELETE = defineRoute<'public','none',{ taskId: string }>(
  {
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  ({ request, params }) => unguardedDELETE(request, { params: Promise.resolve(params) }),
)
