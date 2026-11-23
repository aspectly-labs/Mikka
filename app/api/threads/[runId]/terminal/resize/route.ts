import { pool } from '@/lib/db'
import { threadTerminalHandlers, threadTerminalRuntime } from '@/lib/cloud-computer/thread-terminal'

const handlers = threadTerminalHandlers(threadTerminalRuntime(pool))

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  return handlers.resize(request, (await params).runId)
}
