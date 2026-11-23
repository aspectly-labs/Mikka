import { pool } from '@/lib/db'
import { threadTerminalHandlers, threadTerminalRuntime } from '@/lib/cloud-computer/thread-terminal'

const handlers = threadTerminalHandlers(threadTerminalRuntime(pool))

/** The thread's live terminal leases (#2940). */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  return handlers.list(request, (await params).runId)
}
