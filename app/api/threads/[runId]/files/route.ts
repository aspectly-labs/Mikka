import { pool } from '@/lib/db'
import { threadFilesRoute } from '@/lib/cloud-computer/thread-files'
export const maxDuration = 60

/** The Files tab's「This thread」projection (#2940). */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  return threadFilesRoute(request, pool, (await params).runId)
}
