import { withRequestLog } from '@/lib/request-log'
import { reviewTerminal } from '@/lib/coding-workspace/terminal/http'
import { defineRoute } from '@/lib/primitives/define-route'


const unguardedPOST = withRequestLog('/api/tasks/[taskId]/review/terminal/resize', async (request, { params }: { params: Promise<{ taskId: string }> }) =>
  reviewTerminal.resize(request, (await params).taskId))
export const POST = defineRoute<'public','none',{ taskId: string }>(
  {
    auth: 'public',
    origin: 'any',
    workspace: 'none',
  },
  ({ request, params }) => unguardedPOST(request, { params: Promise.resolve(params) }),
)
