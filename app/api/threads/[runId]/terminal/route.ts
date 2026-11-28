import { pool } from '@/lib/db'
import { threadTerminalHandlers, threadTerminalRuntime } from '@/lib/cloud-computer/thread-terminal'
import { defineRoute } from '@/lib/primitives/define-route'
export const maxDuration = 300

const handlers = threadTerminalHandlers(threadTerminalRuntime(pool))

/** The Setup tab's terminal sessions for one thread (#2940): GET opens (or
 * rejoins) the named PTY over SSE; DELETE closes it. */
export const GET = defineRoute<'session', 'pat-scoped', { runId: string }>(
  {
    auth: 'session',
    origin: 'any',
    workspace: 'pat-scoped',
  },
  ({ request, params }) => handlers.stream(request, params.runId),
)
export const DELETE = defineRoute<'session', 'pat-scoped', { runId: string }>(
  {
    auth: 'session',
    origin: 'same-origin-or-desktop',
    workspace: 'pat-scoped',
    write: true,
  },
  ({ request, params }) => handlers.close(request, params.runId),
)
