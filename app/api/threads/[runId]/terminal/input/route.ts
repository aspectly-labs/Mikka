import { pool } from '@/lib/db'
import { threadTerminalHandlers, threadTerminalRuntime } from '@/lib/cloud-computer/thread-terminal'
import { defineRoute } from '@/lib/primitives/define-route'

const handlers = threadTerminalHandlers(threadTerminalRuntime(pool))

export const POST = defineRoute<'session', 'pat-scoped', { runId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
  },
  ({ request, params }) => handlers.input(request, params.runId),
)
