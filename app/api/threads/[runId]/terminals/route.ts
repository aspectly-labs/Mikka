import { pool } from '@/lib/db'
import { threadTerminalHandlers, threadTerminalRuntime } from '@/lib/cloud-computer/thread-terminal'
import { defineRoute } from '@/lib/primitives/define-route'

const handlers = threadTerminalHandlers(threadTerminalRuntime(pool))

export const GET = defineRoute<'session', 'pat-scoped', { runId: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  ({ request, params }) => handlers.list(request, params.runId),
)
