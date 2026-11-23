import { pool } from '@/lib/db'
import { threadTerminalHandlers, threadTerminalRuntime } from '@/lib/cloud-computer/thread-terminal'
export const maxDuration = 300

const handlers = threadTerminalHandlers(threadTerminalRuntime(pool))

/** The Setup tab's terminal sessions for one thread (#2940): GET opens (or
 * rejoins) the named PTY over SSE; DELETE closes it. */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  return handlers.stream(request, (await params).runId)
}
export async function DELETE(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  return handlers.close(request, (await params).runId)
}
